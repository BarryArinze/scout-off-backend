#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, String, Symbol, Vec,
};
use scout_off_shared::{
    errors::Error,
    storage::{bump_instance, is_initialized, set_initialized},
};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct TrialOfferData {
    pub details_uri: String,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct TrialOfferRecord {
    pub scout: Address,
    pub player_id: u64,
    pub details_uri: String,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    RegisterContract,
    SubscriptionContract,
    TrialOfferKey(Address, u64),
    ScoutOffers(Address),
    PlayerConnections(u64),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ConnectionContract;

#[contractimpl]
impl ConnectionContract {
    /// One-time contract setup. Stores the admin, register contract, and subscription contract addresses.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address that owns admin-only operations on this contract.
    /// * `register_contract` - Address of the deployed [`RegisterContract`] used to promote
    ///   a player to Elite Tier (level 3) when a trial offer is logged.
    /// * `subscription_contract` - Address of the deployed [`SubscriptionContract`] used to
    ///   verify that a scout has an active subscription or has paid the contact fee.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — Contract has already been initialized.
    pub fn initialize(
        env: Env,
        admin: Address,
        register_contract: Address,
        subscription_contract: Address,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RegisterContract, &register_contract);
        env.storage()
            .instance()
            .set(&DataKey::SubscriptionContract, &subscription_contract);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    /// Record a trial offer between a scout and a player on-chain, promoting the player to Elite Tier.
    ///
    /// Verifies the scout holds an active subscription or has paid the per-player contact fee
    /// via cross-contract calls to the [`SubscriptionContract`]. If authorized, stores the
    /// trial offer, appends the player to the scout's offer list and the scout to the player's
    /// connections list, calls `update_progress_level(player_id, 3)` on the
    /// [`RegisterContract`] to promote the player to Elite Tier, and emits a
    /// `trial_offer_logged` event.
    ///
    /// Repeated calls for the same (scout, player_id) pair are idempotent — the second call
    /// returns `Ok(())` without modifying state.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address (must authorize this call).
    /// * `player_id` - The unique player identifier the trial offer targets.
    /// * `details_uri` - IPFS/Arweave URI pointing to trial offer details. Ignored on
    ///   duplicate calls; the original URI is preserved.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized, or stored contract
    ///   addresses are missing.
    /// * [`Error::Unauthorized`] — Scout has neither an active subscription nor a paid
    ///   contact fee for this player.
    pub fn log_trial_offer(
        env: Env,
        scout: Address,
        player_id: u64,
        details_uri: String,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        scout.require_auth();

        let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);

        // Idempotency: return early if this pair already exists.
        if env.storage().instance().has(&offer_key) {
            bump_instance(&env);
            return Ok(());
        }

        // Authorization: active subscription OR paid contact fee for this player.
        // Cross-contract calls use env.invoke_contract to avoid pulling the
        // register/subscription rlibs into the connection WASM (duplicate symbols).
        let sub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SubscriptionContract)
            .ok_or(Error::NotInitialized)?;

        let is_sub: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(&env, "is_subscribed"),
            vec![&env, scout.clone().into_val(&env)],
        );
        let has_paid: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(&env, "has_paid_contact"),
            vec![&env, scout.clone().into_val(&env), player_id.into_val(&env)],
        );
        if !is_sub && !has_paid {
            return Err(Error::Unauthorized);
        }

        // Persist the trial offer.
        let offer_data = TrialOfferData {
            details_uri: details_uri.clone(),
            created_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&offer_key, &offer_data);

        // Append player_id to this scout's offer list.
        let scout_key = DataKey::ScoutOffers(scout.clone());
        let mut scout_offers: Vec<u64> = env
            .storage()
            .instance()
            .get(&scout_key)
            .unwrap_or_else(|| Vec::new(&env));
        scout_offers.push_back(player_id);
        env.storage().instance().set(&scout_key, &scout_offers);

        // Append scout to this player's connections list.
        let player_key = DataKey::PlayerConnections(player_id);
        let mut player_connections: Vec<Address> = env
            .storage()
            .instance()
            .get(&player_key)
            .unwrap_or_else(|| Vec::new(&env));
        player_connections.push_back(scout.clone());
        env.storage()
            .instance()
            .set(&player_key, &player_connections);

        // Promote player to Elite Tier (level 3) via the register contract.
        let reg_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RegisterContract)
            .ok_or(Error::NotInitialized)?;
        env.invoke_contract::<()>(
            &reg_addr,
            &Symbol::new(&env, "update_progress_level"),
            vec![&env, player_id.into_val(&env), 3u32.into_val(&env)],
        );

        // Emit trial_offer_logged event.
        env.events().publish(
            (
                Symbol::new(&env, "trial_offer_logged"),
                scout.clone(),
                player_id,
            ),
            (details_uri,),
        );

        bump_instance(&env);
        Ok(())
    }

    /// Return all trial offer records for a given player, keyed by player_id.
    ///
    /// Iterates the scout addresses stored in `PlayerConnections(player_id)` and
    /// assembles a full [`TrialOfferRecord`] for each. This is a read-only function;
    /// it requires no authorization.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `player_id` - The unique player identifier whose connections to retrieve.
    ///
    /// # Returns
    /// A `Vec<TrialOfferRecord>` of all trial offers targeting this player (may be empty).
    /// Never errors.
    pub fn get_connections(env: Env, player_id: u64) -> Vec<TrialOfferRecord> {
        let scouts: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::PlayerConnections(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = scouts.len();
        for i in 0..len {
            let scout = scouts.get_unchecked(i);
            let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, TrialOfferData>(&offer_key)
            {
                results.push_back(TrialOfferRecord {
                    scout,
                    player_id,
                    details_uri: data.details_uri,
                    created_at: data.created_at,
                });
            }
        }
        results
    }

    /// Return all trial offers made by a given scout.
    ///
    /// Iterates the player IDs stored in `ScoutOffers(scout)` and assembles a full
    /// [`TrialOfferRecord`] for each. This is a read-only function; it requires no
    /// authorization.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `scout` - The scout's Stellar address whose offers to retrieve.
    ///
    /// # Returns
    /// A `Vec<TrialOfferRecord>` of all trial offers made by this scout (may be empty).
    /// Never errors.
    pub fn get_trial_offers(env: Env, scout: Address) -> Vec<TrialOfferRecord> {
        let player_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ScoutOffers(scout.clone()))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = player_ids.len();
        for i in 0..len {
            let player_id = player_ids.get_unchecked(i);
            let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, TrialOfferData>(&offer_key)
            {
                results.push_back(TrialOfferRecord {
                    scout: scout.clone(),
                    player_id,
                    details_uri: data.details_uri,
                    created_at: data.created_at,
                });
            }
        }
        results
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};
    use register::{RegisterContract, RegisterContractClient};
    use subscription::{SubscriptionContract, SubscriptionContractClient};

    fn setup(
        env: &Env,
    ) -> (
        ConnectionContractClient<'_>,
        RegisterContractClient<'_>,
        SubscriptionContractClient<'_>,
        Address,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let token = Address::generate(env);

        let reg_id = env.register_contract(None, RegisterContract);
        let sub_id = env.register_contract(None, SubscriptionContract);
        let conn_id = env.register_contract(None, ConnectionContract);

        let reg_client = RegisterContractClient::new(env, &reg_id);
        let sub_client = SubscriptionContractClient::new(env, &sub_id);
        let conn_client = ConnectionContractClient::new(env, &conn_id);

        reg_client.initialize(&admin, &token, &100u32);
        sub_client.initialize(&admin, &token, &100u32);
        conn_client.initialize(&admin, &reg_id, &sub_id);

        // Grant the connection contract permission to update player progress levels.
        reg_client.set_authorized_updater(&conn_id);

        (conn_client, reg_client, sub_client, admin)
    }

    #[test]
    fn log_trial_offer_with_subscription_sets_progress_to_3() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );
        assert_eq!(reg_client.get_player(&player_id).progress_level, 0);

        sub_client.subscribe(&scout, &1u32, &1000u32);

        conn_client.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));

        assert_eq!(reg_client.get_player(&player_id).progress_level, 3);
    }

    #[test]
    fn log_trial_offer_promotes_level_2_to_3() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        // Simulate prior progression to level 2.
        reg_client.update_progress_level(&player_id, &2u32);
        assert_eq!(reg_client.get_player(&player_id).progress_level, 2);

        sub_client.subscribe(&scout, &1u32, &1000u32);
        conn_client.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));

        assert_eq!(reg_client.get_player(&player_id).progress_level, 3);
    }

    #[test]
    fn unauthorized_scout_cannot_log_trial_offer() {
        let env = Env::default();
        let (conn_client, reg_client, _sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        // No subscription, no contact fee — must fail.
        let result = conn_client.try_log_trial_offer(
            &scout,
            &player_id,
            &String::from_str(&env, "ipfs://offer"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn log_trial_offer_with_contact_fee_succeeds() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        // Pay per-player contact fee instead of a subscription.
        sub_client.pay_to_contact(&scout, &player_id);
        conn_client.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));

        assert_eq!(reg_client.get_player(&player_id).progress_level, 3);
    }

    #[test]
    fn duplicate_log_trial_offer_is_idempotent() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        sub_client.subscribe(&scout, &1u32, &1000u32);

        conn_client.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));
        // Second call with a different URI — must succeed without duplicate state.
        conn_client.log_trial_offer(
            &scout,
            &player_id,
            &String::from_str(&env, "ipfs://offer2"),
        );

        let connections = conn_client.get_connections(&player_id);
        assert_eq!(connections.len(), 1);
        // Original URI is preserved.
        assert_eq!(
            connections.get(0).unwrap().details_uri,
            String::from_str(&env, "ipfs://offer")
        );
    }

    #[test]
    fn get_connections_returns_all_scouts_for_player() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout1 = Address::generate(&env);
        let scout2 = Address::generate(&env);
        let wallet = Address::generate(&env);

        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        sub_client.subscribe(&scout1, &1u32, &1000u32);
        sub_client.subscribe(&scout2, &1u32, &1000u32);

        conn_client
            .log_trial_offer(&scout1, &player_id, &String::from_str(&env, "ipfs://offer1"));
        conn_client
            .log_trial_offer(&scout2, &player_id, &String::from_str(&env, "ipfs://offer2"));

        let connections = conn_client.get_connections(&player_id);
        assert_eq!(connections.len(), 2);
    }

    #[test]
    fn get_trial_offers_returns_all_offers_by_scout() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let w1 = Address::generate(&env);
        let w2 = Address::generate(&env);

        let p1 = reg_client.register_player(
            &w1,
            &String::from_str(&env, "ipfs://1"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );
        let p2 = reg_client.register_player(
            &w2,
            &String::from_str(&env, "ipfs://2"),
            &String::from_str(&env, "midfielder"),
            &String::from_str(&env, "europe"),
        );

        sub_client.subscribe(&scout, &1u32, &1000u32);

        conn_client.log_trial_offer(&scout, &p1, &String::from_str(&env, "ipfs://o1"));
        conn_client.log_trial_offer(&scout, &p2, &String::from_str(&env, "ipfs://o2"));

        let offers = conn_client.get_trial_offers(&scout);
        assert_eq!(offers.len(), 2);
    }

    #[test]
    fn invariant_trial_offer_logging_is_idempotent_and_non_decreasing() {
        let env = Env::default();
        let (conn_client, reg_client, sub_client, _admin) = setup(&env);

        let scout = Address::generate(&env);
        let wallet = Address::generate(&env);
        let player_id = reg_client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        let mut has_logged_offer = false;
        let mut state = 0x1234_abcd_u64;
        for step in 0..24 {
            match state % 3 {
                0 => {
                    let duration = ((state >> 5) % 4 + 1) as u32;
                    sub_client.subscribe(&scout, &1u32, &duration);
                }
                1 => {
                    sub_client.pay_to_contact(&scout, &player_id);
                }
                _ => {}
            }

            let before_len = conn_client.get_connections(&player_id).len();
            let before_level = reg_client.get_player(&player_id).progress_level;
            let result = conn_client.try_log_trial_offer(
                &scout,
                &player_id,
                &String::from_str(&env, "ipfs://offer"),
            );
            let after_len = conn_client.get_connections(&player_id).len();
            let after_level = reg_client.get_player(&player_id).progress_level;

            if result.is_ok() {
                if has_logged_offer {
                    assert_eq!(after_len, before_len, "duplicate offer should not duplicate state");
                } else {
                    assert_eq!(after_len, before_len + 1, "first successful offer should add a connection");
                    has_logged_offer = true;
                }
                assert!(after_level >= before_level, "progress should not decrease after a successful offer");
            } else {
                assert_eq!(after_len, before_len, "failed offer must not mutate connections");
                assert_eq!(after_level, before_level, "failed offer must not mutate progress");
            }

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (conn_client, _reg_client, _sub_client, admin) = setup(&env);

        let result = conn_client.try_initialize(
            &admin,
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert!(result.is_err());
    }
}
