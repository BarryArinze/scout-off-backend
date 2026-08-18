#![no_std]
//! # PlayerToken contract
//!
//! Scaffold for the fractionalized player-sponsorship feature. Fans purchase
//! **Player Tokens** to fund a young player's training. If the player turns
//! professional a percentage of their transfer fee is distributed back to
//! token holders proportionally via this contract.
//!
//! ## Design constraints (stub stage)
//! * Full mainnet deployment and real XLM transfers are **out of scope**; this
//!   contract provides the storage model and arithmetic so the backend and future
//!   on-chain integrations have a stable interface to build against.
//! * `distribute_fee` processes at most **20 holders per call** to stay within
//!   Soroban execution limits; callers must page through holders using the `page`
//!   argument.
//! * All token amounts are stored as `u64` (stroops-equivalent precision).

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};
use scout_off_shared::{
    errors::Error,
    storage::{bump_instance, is_initialized, set_initialized},
};

// ── Constants ──────────────────────────────────────────────────────────────

/// Maximum number of holders processed per `distribute_fee` call.
pub const MAX_HOLDERS_PER_PAGE: u32 = 20;

// ── Data types ─────────────────────────────────────────────────────────────

/// Top-level metadata stored for each player's token issuance.
#[contracttype]
#[derive(Clone)]
pub struct TokenMeta {
    /// Total supply of tokens issued for this player (must be > 0).
    pub total_supply: u64,
    /// Tokens that have been sold so far (≤ total_supply).
    pub sold: u64,
    /// Cumulative XLM (in stroops) distributed to all holders to date.
    pub total_distributed: u128,
}

/// A single holder's balance entry stored under `HolderBalance(player_id, holder)`.
#[contracttype]
#[derive(Clone)]
pub struct HolderBalance {
    pub tokens: u64,
}

/// A queued XLM transfer produced by `distribute_fee` (stub: no real token
/// transfer is executed; the queue is stored in contract state for an off-chain
/// relayer or a follow-up contract call to execute).
#[contracttype]
#[derive(Clone)]
pub struct PendingPayout {
    pub holder: Address,
    pub amount_stroops: u128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// TokenMeta for a given player.
    TokenMeta(u64),
    /// Ordered list of holder addresses for a given player.
    HolderList(u64),
    /// Balance entry for a specific (player, holder) pair.
    HolderBalance(u64, Address),
    /// Pending payouts queued by `distribute_fee` for a player (page-keyed).
    PendingPayouts(u64, u32),
}

// ── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct PlayerTokenContract;

#[contractimpl]
impl PlayerTokenContract {
    // ── Admin setup ────────────────────────────────────────────────────────

    /// One-time initialisation. Stores the admin address.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — already called.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    // ── Token issuance ─────────────────────────────────────────────────────

    /// Issue a fixed supply of Player Tokens for `player_id`.
    ///
    /// Can only be called once per player. The admin authorises this call.
    ///
    /// # Arguments
    /// * `player_id`    — on-chain player identifier from the register contract.
    /// * `total_supply` — number of tokens to create. Must be ≥ 1.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]    — contract not yet initialised.
    /// * [`Error::Unauthorized`]      — caller is not the admin.
    /// * [`Error::AlreadyVerified`]   — tokens already issued for this player.
    /// * [`Error::InvalidInput`]      — `total_supply` is zero.
    pub fn issue_tokens(env: Env, player_id: u64, total_supply: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if total_supply == 0 {
            return Err(Error::InvalidInput);
        }
        if env
            .storage()
            .instance()
            .has(&DataKey::TokenMeta(player_id))
        {
            return Err(Error::AlreadyVerified); // already issued
        }

        let meta = TokenMeta {
            total_supply,
            sold: 0,
            total_distributed: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(player_id), &meta);
        env.storage()
            .instance()
            .set(&DataKey::HolderList(player_id), &Vec::<Address>::new(&env));

        env.events().publish(
            (symbol_short!("tok_iss"), player_id),
            (total_supply,),
        );
        bump_instance(&env);
        Ok(())
    }

    // ── Token purchase ─────────────────────────────────────────────────────

    /// Purchase `amount` tokens for `player_id` on behalf of `buyer`.
    ///
    /// Stub: no XLM transfer is executed; the balance is updated in contract
    /// storage only. A real implementation would call the XLM token contract here.
    ///
    /// # Arguments
    /// * `player_id` — target player.
    /// * `amount`    — number of tokens to buy (≥ 1).
    /// * `buyer`     — purchasing address (must authorise this call).
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]     — contract not initialised.
    /// * [`Error::InvalidInput`]       — no tokens issued for this player, or
    ///                                   `amount` is zero.
    /// * [`Error::InsufficientSupply`] — `amount` exceeds the player's remaining
    ///                                   unsold supply.
    pub fn buy_token(env: Env, player_id: u64, amount: u64, buyer: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        buyer.require_auth();

        if amount == 0 {
            return Err(Error::InvalidInput);
        }

        let mut meta: TokenMeta = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)?; // no tokens issued

        let remaining = meta.total_supply.checked_sub(meta.sold).unwrap_or(0);
        if amount > remaining {
            return Err(Error::InsufficientSupply);
        }

        // Update or create holder balance.
        let balance_key = DataKey::HolderBalance(player_id, buyer.clone());
        let prev: u64 = env
            .storage()
            .instance()
            .get::<DataKey, HolderBalance>(&balance_key)
            .map(|b| b.tokens)
            .unwrap_or(0);

        let new_balance = prev
            .checked_add(amount)
            .ok_or(Error::Overflow)?;

        env.storage()
            .instance()
            .set(&balance_key, &HolderBalance { tokens: new_balance });

        // Append to holder list only on first purchase.
        if prev == 0 {
            let list_key = DataKey::HolderList(player_id);
            let mut list: Vec<Address> = env
                .storage()
                .instance()
                .get(&list_key)
                .unwrap_or_else(|| Vec::new(&env));
            list.push_back(buyer.clone());
            env.storage().instance().set(&list_key, &list);
        }

        meta.sold = meta.sold.checked_add(amount).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(player_id), &meta);

        env.events().publish(
            (symbol_short!("tok_buy"), player_id),
            (buyer, amount),
        );
        bump_instance(&env);
        Ok(())
    }

    // ── Fee distribution ───────────────────────────────────────────────────

    /// Calculate and queue pro-rata XLM payouts to token holders.
    ///
    /// Processes at most [`MAX_HOLDERS_PER_PAGE`] (20) holders per call. Callers
    /// must increment `page` (0-indexed) to process subsequent batches.
    ///
    /// Stub: XLM transfers are not executed. Each holder's payout is stored as a
    /// [`PendingPayout`] entry under `DataKey::PendingPayouts(player_id, page)`.
    /// An off-chain relayer or follow-up contract call is responsible for execution.
    ///
    /// # Arguments
    /// * `player_id`        — target player.
    /// * `transfer_fee_xlm` — total transfer fee in stroops to distribute.
    /// * `page`             — 0-indexed page of holders to process this call.
    ///
    /// # Returns
    /// `Ok(payouts_queued)` — number of holder payouts queued in this call.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]  — contract not initialised.
    /// * [`Error::InvalidInput`]    — no tokens issued, sold is zero, or
    ///                                 `transfer_fee_xlm` is zero.
    /// * [`Error::Overflow`]        — arithmetic overflow in payout calculation.
    pub fn distribute_fee(
        env: Env,
        player_id: u64,
        transfer_fee_xlm: u128,
        page: u32,
    ) -> Result<u32, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }

        if transfer_fee_xlm == 0 {
            return Err(Error::InvalidInput);
        }

        let meta: TokenMeta = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)?;

        if meta.sold == 0 {
            return Err(Error::InvalidInput);
        }

        let holders: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::HolderList(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let start = (page * MAX_HOLDERS_PER_PAGE) as usize;
        let end = ((page + 1) * MAX_HOLDERS_PER_PAGE) as usize;
        let total_holders = holders.len() as usize;

        if start >= total_holders {
            // No holders on this page — nothing to queue.
            return Ok(0);
        }

        let end = end.min(total_holders);
        let mut payouts: Vec<PendingPayout> = Vec::new(&env);
        let total_sold = meta.sold as u128;

        for i in start..end {
            let holder = holders.get_unchecked(i as u32);
            let balance_key = DataKey::HolderBalance(player_id, holder.clone());
            let tokens: u64 = env
                .storage()
                .instance()
                .get::<DataKey, HolderBalance>(&balance_key)
                .map(|b| b.tokens)
                .unwrap_or(0);

            if tokens == 0 {
                continue;
            }

            // pro-rata share = transfer_fee_xlm * tokens / total_sold
            // Use checked arithmetic; overflow here means the inputs are
            // pathologically large (fee > u128::MAX / tokens), which the
            // contract rejects with Error::Overflow.
            let numerator = transfer_fee_xlm
                .checked_mul(tokens as u128)
                .ok_or(Error::Overflow)?;
            let share = numerator / total_sold; // integer division (floor)

            if share > 0 {
                payouts.push_back(PendingPayout {
                    holder: holder.clone(),
                    amount_stroops: share,
                });
            }
        }

        let queued = payouts.len();
        if queued > 0 {
            env.storage()
                .instance()
                .set(&DataKey::PendingPayouts(player_id, page), &payouts);
        }

        // Update cumulative distributed amount (best-effort; skip on overflow).
        let page_total: u128 = payouts
            .iter()
            .fold(0u128, |acc, p| acc.saturating_add(p.amount_stroops));
        let mut updated_meta = meta;
        updated_meta.total_distributed = updated_meta
            .total_distributed
            .saturating_add(page_total);
        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(player_id), &updated_meta);

        env.events().publish(
            (Symbol::new(&env, "fee_dist"), player_id, page),
            (transfer_fee_xlm, queued),
        );
        bump_instance(&env);
        Ok(queued)
    }

    // ── Queries ────────────────────────────────────────────────────────────

    /// Return the token balance for a given `(player_id, holder)` pair.
    ///
    /// Returns 0 if no tokens have been purchased.
    pub fn get_balance(env: Env, player_id: u64, holder: Address) -> u64 {
        env.storage()
            .instance()
            .get::<DataKey, HolderBalance>(&DataKey::HolderBalance(player_id, holder))
            .map(|b| b.tokens)
            .unwrap_or(0)
    }

    /// Return the [`TokenMeta`] for a player, or an error if no tokens were issued.
    ///
    /// # Errors
    /// * [`Error::InvalidInput`] — no tokens issued for this player.
    pub fn get_token_meta(env: Env, player_id: u64) -> Result<TokenMeta, Error> {
        env.storage()
            .instance()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)
    }

    /// Return the ordered list of holder addresses for a player.
    pub fn get_holders(env: Env, player_id: u64) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::HolderList(player_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Return the pending payouts queued for a given `(player_id, page)`.
    pub fn get_pending_payouts(env: Env, player_id: u64, page: u32) -> Vec<PendingPayout> {
        env.storage()
            .instance()
            .get(&DataKey::PendingPayouts(player_id, page))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(env: &Env) -> (PlayerTokenContractClient<'_>, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, PlayerTokenContract);
        let client = PlayerTokenContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn issue_tokens_with_zero_supply_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        assert!(client.try_issue_tokens(&1u64, &0u64).is_err());
    }

    #[test]
    fn issue_tokens_succeeds_and_is_idempotent_via_error() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        client.issue_tokens(&1u64, &1000u64);
        // Second issue for same player must fail.
        assert!(client.try_issue_tokens(&1u64, &500u64).is_err());
    }

    #[test]
    fn buy_token_updates_balance_and_sold_count() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);

        client.issue_tokens(&1u64, &100u64);
        client.buy_token(&1u64, &30u64, &buyer);

        assert_eq!(client.get_balance(&1u64, &buyer), 30);
        let meta = client.get_token_meta(&1u64);
        assert_eq!(meta.sold, 30);
    }

    #[test]
    fn buy_token_exceeding_supply_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&1u64, &10u64);
        assert_eq!(
            client.try_buy_token(&1u64, &11u64, &buyer),
            Err(Ok(Error::InsufficientSupply))
        );
    }

    #[test]
    fn buy_token_exactly_exhausts_supply_succeeds() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&1u64, &10u64);
        // Buying exactly the remaining supply must succeed.
        assert!(client.try_buy_token(&1u64, &10u64, &buyer).is_ok());
        assert_eq!(client.get_balance(&1u64, &buyer), 10);
        // Any further purchase is rejected with InsufficientSupply.
        assert_eq!(
            client.try_buy_token(&1u64, &1u64, &buyer),
            Err(Ok(Error::InsufficientSupply))
        );
    }

    #[test]
    fn distribute_fee_pro_rata_three_holders() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        let b3 = Address::generate(&env);

        client.issue_tokens(&1u64, &100u64);
        client.buy_token(&1u64, &50u64, &b1); // 50%
        client.buy_token(&1u64, &30u64, &b2); // 30%
        client.buy_token(&1u64, &20u64, &b3); // 20%

        // Distribute 1_000_000 stroops (1 XLM) across page 0.
        let queued = client.distribute_fee(&1u64, &1_000_000u128, &0u32);
        assert_eq!(queued, 3);

        let payouts = client.get_pending_payouts(&1u64, &0u32);
        assert_eq!(payouts.len(), 3);

        // Verify pro-rata amounts (integer division).
        let p0 = payouts.get(0).unwrap();
        let p1 = payouts.get(1).unwrap();
        let p2 = payouts.get(2).unwrap();
        assert_eq!(p0.amount_stroops, 500_000); // 50%
        assert_eq!(p1.amount_stroops, 300_000); // 30%
        assert_eq!(p2.amount_stroops, 200_000); // 20%

        // Total distributed must not exceed the fee.
        let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
        assert!(total <= 1_000_000);
    }

    #[test]
    fn distribute_fee_rounding_for_non_integer_shares() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        let b3 = Address::generate(&env);

        // 3 holders with equal 1-token balances; fee = 10 (not divisible by 3).
        client.issue_tokens(&2u64, &3u64);
        client.buy_token(&2u64, &1u64, &b1);
        client.buy_token(&2u64, &1u64, &b2);
        client.buy_token(&2u64, &1u64, &b3);

        let queued = client.distribute_fee(&2u64, &10u128, &0u32);
        assert_eq!(queued, 3);

        let payouts = client.get_pending_payouts(&2u64, &0u32);
        let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
        // Floor division: each gets 3, total = 9 (≤ 10 — rounding remainder stays in contract).
        assert!(total <= 10, "total payouts {} must not exceed fee 10", total);
        for p in payouts.iter() {
            assert_eq!(p.amount_stroops, 3);
        }
    }

    #[test]
    fn distribute_fee_zero_transfer_fee_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&3u64, &100u64);
        client.buy_token(&3u64, &1u64, &buyer);
        assert!(client.try_distribute_fee(&3u64, &0u128, &0u32).is_err());
    }

    #[test]
    fn distribute_fee_with_no_sold_tokens_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        client.issue_tokens(&4u64, &100u64);
        // No buyers yet — sold = 0.
        assert!(client.try_distribute_fee(&4u64, &1_000u128, &0u32).is_err());
    }

    #[test]
    fn distribute_fee_paging_returns_zero_beyond_holder_count() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&5u64, &100u64);
        client.buy_token(&5u64, &1u64, &buyer);
        // Only 1 holder; page 1 should return 0.
        let queued = client.distribute_fee(&5u64, &1_000u128, &1u32);
        assert_eq!(queued, 0);
    }

    #[test]
    fn get_holders_returns_all_buyers() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        client.issue_tokens(&6u64, &100u64);
        client.buy_token(&6u64, &10u64, &b1);
        client.buy_token(&6u64, &10u64, &b2);
        let holders = client.get_holders(&6u64);
        assert_eq!(holders.len(), 2);
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        assert!(client.try_initialize(&admin).is_err());
    }
}
