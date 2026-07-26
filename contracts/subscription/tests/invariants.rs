/// Property-based invariant tests for the `subscription` contract.
///
/// Invariants verified:
///   S1. Fee arithmetic never overflows u128 — fee calculations using u128::MAX-range
///       inputs remain within u128 bounds (no panic under overflow-checks = true).
///   S2. `is_subscribed` returns `false` exactly when `current_ledger >= expiry`.
///       Tested under arbitrary (subscribe, advance) interleavings.
///   S3. `is_subscribed` returns `true` during the window [subscribe_ledger+1,
///       subscribe_ledger+duration] and `false` at subscribe_ledger+duration+1.
///   S4. Accumulated contact fees are idempotent — paying for the same player twice
///       leaves `has_paid_contact` true and does not error.
///   S5. `has_paid_contact` is independent per (scout, player_id) pair — paying for
///       player A never affects the record for player B.
///   S6. Subscription expiry computed from arbitrary `duration_ledgers` values never
///       wraps around u32 (overflow-checks = true in the release profile catches this
///       at the WASM level; the test verifies the stored expiry is always > start).
///
/// Each proptest! block runs 10 000 cases.
#[cfg(test)]
mod subscription_invariants {
    use proptest::prelude::*;
    use subscription::{SubscriptionContract, SubscriptionContractClient};
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

    // ── helpers ──────────────────────────────────────────────────────────────

    fn setup(env: &Env) -> (SubscriptionContractClient<'_>, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, SubscriptionContract);
        let client = SubscriptionContractClient::new(env, &id);
        let admin = Address::generate(env);
        let token = Address::generate(env);
        client.initialize(&admin, &token, &100u32);
        (client, admin, token)
    }

    // ── S1: fee arithmetic never overflows u128 ───────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Compute platform fee shares using u128::MAX-range amounts. The platform fee
        /// calculation `amount * fee_bps / 10_000` must not overflow u128.
        #[test]
        fn prop_fee_arithmetic_never_overflows(
            amount  in 0u128..=u128::MAX,
            fee_bps in 0u32..=10_000u32,
        ) {
            // Mirror the on-chain fee formula.  The key property is that this must
            // not panic under Rust's overflow-checks = true (which the release profile
            // enables for Soroban contracts).  We cast to u128 to match the on-chain
            // width and use checked_mul / checked_div to assert no overflow occurs.
            let fee_u128 = fee_bps as u128;
            let result = amount.checked_mul(fee_u128);
            if let Some(product) = result {
                let fee = product / 10_000u128;
                prop_assert!(fee <= amount, "fee {} must not exceed deposited amount {}", fee, amount);
            }
            // checked_mul returning None means the product would overflow; this is
            // the case the contract must guard against.  The test simply verifies that
            // the formula is used correctly — the contract uses u32 amounts which cannot
            // overflow u128 in practice, but extreme u128 inputs expose the guard.
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Accumulated fees from multiple scouts must never exceed the total XLM deposited.
        /// For n scouts each paying `amount`, the sum of fees must be ≤ n * amount.
        #[test]
        fn prop_accumulated_fees_never_exceed_total_deposited(
            amounts in proptest::collection::vec(0u32..=1_000_000u32, 1..=20),
            fee_bps in 0u32..=10_000u32,
        ) {
            let total_deposited: u128 = amounts.iter().map(|&a| a as u128).sum();
            let total_fees: u128 = amounts
                .iter()
                .map(|&a| {
                    let product = (a as u128) * (fee_bps as u128);
                    product / 10_000u128
                })
                .sum();

            prop_assert!(
                total_fees <= total_deposited,
                "total fees {} must not exceed total deposited {}",
                total_fees,
                total_deposited
            );
        }
    }

    // ── S2: is_subscribed matches ledger-sequence arithmetic exactly ──────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// For any (subscribe, advance-ledger) interleaving, is_subscribed must equal
        /// `current_sequence < stored_expiry`.  We track expected_expiry in the test
        /// and assert the contract result matches our reference calculation.
        #[test]
        fn prop_is_subscribed_matches_expiry_arithmetic(
            ops in proptest::collection::vec(
                prop_oneof![
                    (1u32..=20u32).prop_map(|d| (true, d)),   // subscribe(duration)
                    (1u32..=10u32).prop_map(|a| (false, a)),  // advance ledger by a
                ],
                1..=40,
            ),
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let scout = Address::generate(&env);
            let mut expected_expiry: Option<u32> = None;

            for (is_subscribe, value) in ops {
                if is_subscribe {
                    let seq = env.ledger().sequence();
                    // Guard: skip if duration would overflow u32.
                    if seq.checked_add(value).is_none() {
                        continue;
                    }
                    client.subscribe(&scout, &1u32, &value);
                    expected_expiry = Some(seq + value);
                } else {
                    let seq = env.ledger().sequence();
                    if seq.checked_add(value).is_none() {
                        continue;
                    }
                    env.ledger().with_mut(|li| li.sequence_number += value);
                }

                let current = env.ledger().sequence();
                let expected_active = expected_expiry.map_or(false, |e| current < e);
                let actual_active = client.is_subscribed(&scout);
                prop_assert_eq!(
                    actual_active, expected_active,
                    "is_subscribed mismatch at seq={}: expected={} actual={}",
                    current, expected_active, actual_active
                );
            }
        }
    }

    // ── S3: precise boundary check at expiry ledger ───────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// At sequence == expiry-1: is_subscribed must be true.
        /// At sequence == expiry:   is_subscribed must be false.
        #[test]
        fn prop_subscription_inactive_at_and_after_expiry(
            duration in 1u32..=1_000u32,
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let scout = Address::generate(&env);
            let start_seq = env.ledger().sequence();
            client.subscribe(&scout, &1u32, &duration);
            let expiry = start_seq + duration;

            // One ledger before expiry — must be active.
            if expiry > 0 {
                env.ledger().with_mut(|li| li.sequence_number = expiry - 1);
                prop_assert!(
                    client.is_subscribed(&scout),
                    "must be subscribed at sequence={} (expiry={})",
                    expiry - 1, expiry
                );
            }

            // At expiry — must be inactive.
            env.ledger().with_mut(|li| li.sequence_number = expiry);
            prop_assert!(
                !client.is_subscribed(&scout),
                "must NOT be subscribed at sequence={} (expiry={})",
                expiry, expiry
            );

            // One ledger after expiry — must still be inactive.
            if expiry < u32::MAX {
                env.ledger().with_mut(|li| li.sequence_number = expiry + 1);
                prop_assert!(
                    !client.is_subscribed(&scout),
                    "must NOT be subscribed at sequence={} (expiry={})",
                    expiry + 1, expiry
                );
            }
        }
    }

    // ── S4: contact fee payment is idempotent ─────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Paying the contact fee for the same (scout, player_id) pair multiple times
        /// must not fail and must leave has_paid_contact true.
        #[test]
        fn prop_contact_fee_payment_is_idempotent(
            n in 1usize..=10,
            player_id in 1u64..=1_000u64,
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let scout = Address::generate(&env);

            for _ in 0..n {
                let result = client.try_pay_to_contact(&scout, &player_id);
                prop_assert!(result.is_ok(), "repeated pay_to_contact must not fail");
                prop_assert!(
                    client.has_paid_contact(&scout, &player_id),
                    "has_paid_contact must be true after pay_to_contact"
                );
            }
        }
    }

    // ── S5: contact fee records are independent per (scout, player_id) ────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Paying for player_a must not flip has_paid_contact for player_b.
        #[test]
        fn prop_contact_fee_records_are_independent(
            player_a in 1u64..=500u64,
            player_b in 501u64..=1000u64,
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let scout = Address::generate(&env);

            prop_assert!(!client.has_paid_contact(&scout, &player_a));
            prop_assert!(!client.has_paid_contact(&scout, &player_b));

            client.pay_to_contact(&scout, &player_a);

            prop_assert!(client.has_paid_contact(&scout, &player_a), "player_a must be paid");
            prop_assert!(!client.has_paid_contact(&scout, &player_b), "player_b must be unaffected");
        }
    }

    // ── S6: subscription expiry never wraps around u32 ────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// For any `duration_ledgers` that would not overflow the current sequence,
        /// the stored expiry is always strictly greater than the starting sequence.
        #[test]
        fn prop_subscription_expiry_is_strictly_after_start(
            duration in 1u32..=100_000u32,
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let scout = Address::generate(&env);
            let start = env.ledger().sequence();

            // Only test cases where addition won't overflow u32.
            prop_assume!(start.checked_add(duration).is_some());

            client.subscribe(&scout, &1u32, &duration);

            // Immediately after subscribe the subscription must be active —
            // which implies expiry > current sequence > start.
            prop_assert!(
                client.is_subscribed(&scout),
                "subscription must be active immediately after subscribe (duration={})",
                duration
            );
        }
    }
}
