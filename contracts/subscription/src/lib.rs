#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};
use scout_off_shared::{
    errors::Error,
    events::{emit_contact_unlocked, emit_scout_subscribed},
    storage::{bump_instance, is_initialized, set_initialized},
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    PlatformFeeBps,
    Subscription(Address),
    ContactFee(Address, u64),
}

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// One-time contract setup. Stores the admin, payment token, and platform contact fee.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address authorized to call [`set_platform_fee_bps`].
    /// * `token` - The XLM or platform-token contract address used for subscription payments.
    /// * `platform_fee_bps` - Initial platform fee in basis points (e.g. `500` = 5 %).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — Contract has already been initialized.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        platform_fee_bps: u32,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    /// Purchase a scout subscription for the given tier and duration (in ledgers).
    ///
    /// Stores the subscription expiry as `current_ledger_sequence + duration_ledgers`.
    /// Calling again while a subscription is still active overwrites the stored expiry
    /// with a new value computed from the current sequence. Emits a `scout_subscribed` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address (must authorize this call).
    /// * `tier` - Subscription tier level (`u32`); used in the emitted event.
    /// * `duration_ledgers` - Number of ledgers the subscription should remain active.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    pub fn subscribe(
        env: Env,
        scout: Address,
        tier: u32,
        duration_ledgers: u32,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        scout.require_auth();
        let expiry = env.ledger().sequence() + duration_ledgers;
        env.storage()
            .instance()
            .set(&DataKey::Subscription(scout.clone()), &expiry);
        bump_instance(&env);
        emit_scout_subscribed(&env, &scout, tier, duration_ledgers, expiry);
        Ok(())
    }

    /// Unlock direct contact with a specific player by paying the per-player micro-fee.
    ///
    /// Records the (scout, player_id) pair in contract storage so that
    /// [`has_paid_contact`] returns `true` for that pair. Emits a `contact_unlocked` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address (must authorize this call).
    /// * `player_id` - The unique player identifier to unlock contact for.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    pub fn pay_to_contact(env: Env, scout: Address, player_id: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        scout.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::ContactFee(scout.clone(), player_id), &true);
        bump_instance(&env);
        emit_contact_unlocked(&env, &scout, player_id);
        Ok(())
    }

    /// Return `true` if the scout has an active (non-expired) subscription.
    ///
    /// Compares the stored expiry ledger sequence against the current ledger sequence.
    /// A scout with no subscription record returns `false`.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address to check.
    ///
    /// # Returns
    /// `true` if the subscription expiry is strictly greater than the current ledger sequence,
    /// `false` otherwise. Never errors.
    pub fn is_subscribed(env: Env, scout: Address) -> bool {
        let expiry: u32 = match env
            .storage()
            .instance()
            .get(&DataKey::Subscription(scout))
        {
            Some(e) => e,
            None => return false,
        };
        env.ledger().sequence() < expiry
    }

    /// Return `true` if the scout has paid the contact fee for the given player.
    ///
    /// Checks whether a `ContactFee(scout, player_id)` entry exists in instance storage.
    /// This is a read-only function; it requires no authorization.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address to check.
    /// * `player_id` - The unique player identifier to check.
    ///
    /// # Returns
    /// `true` if the contact fee has been paid, `false` otherwise. Never errors.
    pub fn has_paid_contact(env: Env, scout: Address, player_id: u64) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::ContactFee(scout, player_id))
    }

    /// Update the platform fee in basis points. Only the admin may call this.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The admin's Stellar address (must authorize this call and match stored admin).
    /// * `platform_fee_bps` - New fee expressed in basis points (e.g. `250` = 2.5 %).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller does not match the stored admin address.
    pub fn set_platform_fee_bps(env: Env, admin: Address, platform_fee_bps: u32) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        bump_instance(&env);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup(env: &Env) -> (SubscriptionContractClient<'_>, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, SubscriptionContract);
        let client = SubscriptionContractClient::new(env, &id);
        let admin = Address::generate(env);
        let token = Address::generate(env);
        (client, admin, token)
    }

    #[test]
    fn subscribe_succeeds_and_marks_scout_subscribed() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        client.subscribe(&scout, &1u32, &1000u32);

        assert!(client.is_subscribed(&scout));
    }

    #[test]
    fn subscribe_fails_when_not_initialized() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);

        let scout = Address::generate(&env);
        let result = client.try_subscribe(&scout, &1u32, &1000u32);
        assert!(result.is_err());
    }

    #[test]
    fn is_subscribed_false_before_any_subscription() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        assert!(!client.is_subscribed(&scout));
    }

    #[test]
    fn subscription_expires_after_duration_elapses() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        client.subscribe(&scout, &1u32, &1000u32);
        assert!(client.is_subscribed(&scout));

        // Advance the ledger sequence past the subscription's expiry.
        env.ledger().with_mut(|li| {
            li.sequence_number += 1001;
        });

        assert!(!client.is_subscribed(&scout));
    }

    #[test]
    fn resubscribing_while_active_extends_expiry() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        client.subscribe(&scout, &1u32, &1000u32);
        assert!(client.is_subscribed(&scout));

        // Re-subscribing while already active overwrites the stored expiry
        // with a new one computed from the current sequence. There is no
        // rejection path for "already subscribed" in the current contract.
        client.subscribe(&scout, &1u32, &2000u32);
        assert!(client.is_subscribed(&scout));
    }

    #[test]
    fn pay_to_contact_succeeds_and_is_recorded() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        let player_id = 42u64;

        assert!(!client.has_paid_contact(&scout, &player_id));
        client.pay_to_contact(&scout, &player_id);
        assert!(client.has_paid_contact(&scout, &player_id));
    }

    #[test]
    fn pay_to_contact_fails_when_not_initialized() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);

        let scout = Address::generate(&env);
        let result = client.try_pay_to_contact(&scout, &42u64);
        assert!(result.is_err());
    }

    #[test]
    fn invariant_subscription_expiry_is_checked_after_each_sequence_step() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let scout = Address::generate(&env);
        let mut expected_expiry: Option<u32> = None;
        let mut state = 0xfeed_1234u64;

        for step in 0..24 {
            if state % 2 == 0 {
                let duration = ((state >> 5) % 6 + 1) as u32;
                client.subscribe(&scout, &1u32, &duration);
                expected_expiry = Some(env.ledger().sequence() + duration);
            } else {
                let advance_by = ((state >> 2) % 4 + 1) as u32;
                env.ledger().with_mut(|li| {
                    li.sequence_number += advance_by;
                });
            }

            let active = client.is_subscribed(&scout);
            let expected_active = expected_expiry.map_or(false, |expiry| env.ledger().sequence() < expiry);
            assert_eq!(active, expected_active, "step {step}");

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        assert!(client.try_initialize(&admin, &token, &100).is_err());
    }

    #[test]
    fn set_platform_fee_bps_succeeds_for_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        client.set_platform_fee_bps(&admin, &250u32);
        // No getter is exposed for platform_fee_bps, so we assert indirectly:
        // the call completing without error confirms the admin check passed.
    }

    #[test]
    fn set_platform_fee_bps_fails_for_non_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let not_admin = Address::generate(&env);
        let result = client.try_set_platform_fee_bps(&not_admin, &250u32);
        assert!(result.is_err());
    }

    #[test]
    fn set_platform_fee_bps_fails_when_not_initialized() {
        let env = Env::default();
        let (client, admin, _token) = setup(&env);

        let result = client.try_set_platform_fee_bps(&admin, &250u32);
        assert!(result.is_err());
    }
}
