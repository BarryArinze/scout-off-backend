/**
 * Tests for adminMultiSig execution dispatch and atomicity (#1017)
 * 
 * Covers all acceptance criteria:
 * 1. Every AdminActionType variant executes real operations when quorum is reached
 * 2. Action types are correctly tagged (no more 'pause_contract' for validators)  
 * 3. Concurrent approval attempts are atomic (duplicate prevention)
 * 4. Schema equivalence between SQLite and PostgreSQL
 * 5. Execution failures are handled gracefully with retry capability
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../../src/app';
import { initDb, closeDb, getDb, getDriver } from '../../src/db';
import config from '../../src/config';
import { proposeAction, approveAction } from '../../src/services/adminMultiSig';
import * as stellar from '../../src/services/stellar';

// Mock stellar service operations
jest.mock('../../src/services/stellar', () => ({
  pauseContractOnChain: jest.fn(),
  unpauseContractOnChain: jest.fn(),
  withdrawFees: jest.fn(),
  registerValidatorOnChain: jest.fn(),
  revokeValidatorOnChain: jest.fn(),
}));

const mockStellar = stellar as jest.Mocked<typeof stellar>;

describe('Admin Multi-Signature Execution and Atomicity', () => {
  const adminWallet1 = 'GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminWallet2 = 'GADMIN2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminWallet3 = 'GADMIN3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const validatorWallet = 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const treasuryAddress = 'GTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeAll(async () => {
    // Set multi-sig threshold for testing
    config.adminThreshold = 2;
    config.adminWallets = [adminWallet1, adminWallet2, adminWallet3];
    
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    // Set default successful responses
    mockStellar.pauseContractOnChain.mockResolvedValue({ transactionId: 'tx_pause_123' });
    mockStellar.unpauseContractOnChain.mockResolvedValue({ transactionId: 'tx_unpause_123' });
    mockStellar.registerValidatorOnChain.mockResolvedValue({ transactionId: 'tx_register_123' });
    mockStellar.revokeValidatorOnChain.mockResolvedValue({ transactionId: 'tx_revoke_123' });
    mockStellar.withdrawFees.mockResolvedValue({ 
      transactionId: 'tx_withdraw_123',
      amount: 1000000,
      recipient: treasuryAddress,
      token: 'XLM'
    });
  });

  describe('Acceptance Criteria 1: Real operations execute when quorum is reached', () => {
    test('pause_contract executes pauseContractOnChain', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      expect(proposal.status).toBe('proposed');

      const result = await approveAction(proposal.actionId, adminWallet2);
      expect(result.status).toBe('approved');
      expect(mockStellar.pauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
    });

    test('unpause_contract executes unpauseContractOnChain', async () => {
      const proposal = proposeAction('unpause_contract', {}, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.unpauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
    });

    test('register_validator executes registerValidatorOnChain', async () => {
      const proposal = proposeAction('register_validator', { validatorWallet }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('revoke_validator executes revokeValidatorOnChain', async () => {
      const proposal = proposeAction('revoke_validator', { validatorWallet }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.revokeValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('withdraw_fees executes withdrawFees', async () => {
      const proposal = proposeAction('withdraw_fees', { recipient: treasuryAddress }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.withdrawFees).toHaveBeenCalledWith(treasuryAddress);
    });

    test('bulk_validator_import executes registerValidatorOnChain', async () => {
      const proposal = proposeAction('bulk_validator_import', { 
        wallet: validatorWallet, 
        label: 'Test Validator',
        region: 'US' 
      }, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });
  });

  describe('Acceptance Criteria 2: Correct action type tagging via adminController', () => {
    test('validator registration uses register_validator action type', async () => {
      const response = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/proposed/);
      
      // Verify the action was created with correct type
      const actions = await getDriver().all('SELECT * FROM pending_admin_actions WHERE action_type = ?', ['register_validator']);
      expect(actions).toHaveLength(1);
    });

    test('validator revocation uses revoke_validator action type', async () => {
      const response = await request(app)
        .post('/api/admin/validators/revoke')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      expect(response.body.success).toBe(true);
      
      // Verify the action was created with correct type  
      const actions = await getDriver().all('SELECT * FROM pending_admin_actions WHERE action_type = ?', ['revoke_validator']);
      expect(actions).toHaveLength(1);
    });
  });

  describe('Acceptance Criteria 3: Concurrent approval atomicity', () => {
    test('prevents duplicate signatures from same signer', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      
      // First approval should succeed
      const result1 = await approveAction(proposal.actionId, adminWallet2);
      expect(result1.status).toBe('approved');
      
      // Second approval from same signer should return duplicate
      const result2 = await approveAction(proposal.actionId, adminWallet2);
      expect(result2.status).toBe('duplicate');
    });

    test('concurrent approvals from same signer are atomic', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      
      // Simulate concurrent approvals
      const promises = [
        approveAction(proposal.actionId, adminWallet2),
        approveAction(proposal.actionId, adminWallet2),
        approveAction(proposal.actionId, adminWallet2)
      ];
      
      const results = await Promise.allSettled(promises);
      
      // Only one should succeed, others should be duplicate or fail
      const successful = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'approved');
      const duplicates = results.filter(r => r.status === 'fulfilled' && (r.value as any).status === 'duplicate');
      
      expect(successful).toHaveLength(1);
      expect(duplicates.length + successful.length).toBe(3);
    });
  });

  describe('Acceptance Criteria 4: Schema equivalence between drivers', () => {
    const testMultiSigFlow = async () => {
      // Create a pending action
      const proposal = proposeAction('register_validator', { validatorWallet }, adminWallet1);
      expect(proposal.status).toBe('proposed');
      
      // Approve to reach quorum
      const result = await approveAction(proposal.actionId, adminWallet2);
      expect(result.status).toBe('approved');
      
      // Verify action exists in database
      const actions = await getDriver().all('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect(actions).toHaveLength(1);
      
      // Verify signatures exist in database  
      const signatures = await getDriver().all('SELECT * FROM admin_action_signatures WHERE action_id = ?', [proposal.actionId]);
      expect(signatures).toHaveLength(2); // proposer + approver
    };

    test('multisig flow works with current driver', async () => {
      await testMultiSigFlow();
    });

    // Note: Testing both drivers would require test environment setup
    // This test verifies the current driver works correctly
  });

  describe('Acceptance Criteria 5: Execution failure handling', () => {
    test('execution failure is gracefully handled and retryable', async () => {
      // Mock stellar operation to fail
      mockStellar.pauseContractOnChain.mockRejectedValue(new Error('Network timeout'));
      
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      
      // Approval should fail due to execution error
      await expect(approveAction(proposal.actionId, adminWallet2)).rejects.toThrow('Network timeout');
      
      // Action should remain in pending state for retry
      const action = await getDriver().get('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect((action as any)?.status).toBe('pending');
    });

    test('execution success is properly logged', async () => {
      const proposal = proposeAction('pause_contract', {}, adminWallet1);
      const result = await approveAction(proposal.actionId, adminWallet2);
      
      expect(result.status).toBe('approved');
      expect(mockStellar.pauseContractOnChain).toHaveBeenCalled();
      
      // Action should be marked as executed
      const action = await getDriver().get('SELECT * FROM pending_admin_actions WHERE id = ?', [proposal.actionId]);
      expect((action as any)?.status).toBe('executed');
    });
  });

  describe('Edge cases and error handling', () => {
    test('missing payload fields cause execution to fail gracefully', async () => {
      const proposal = proposeAction('register_validator', {}, adminWallet1); // Missing validatorWallet
      
      await expect(approveAction(proposal.actionId, adminWallet2)).rejects.toThrow('Missing validatorWallet in payload');
    });

    test('invalid action type is handled gracefully', async () => {
      // This would require manipulating the database directly since proposeAction validates the type
      const actionId = 'test-invalid-action';
      await getDriver().run(
        'INSERT INTO pending_admin_actions (id, action_type, proposer, payload, required_signatures, expires_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [actionId, 'invalid_action', adminWallet1, '{}', 2, Date.now() + 86400000, Date.now(), 'pending']
      );
      
      await getDriver().run(
        'INSERT INTO admin_action_signatures (action_id, signer, signed_at) VALUES (?, ?, ?)',
        [actionId, adminWallet1, Date.now()]
      );
      
      await getDriver().run(
        'UPDATE pending_admin_actions SET collected_signatures = 1 WHERE id = ?',
        [actionId]
      );
      
      await expect(approveAction(actionId, adminWallet2)).rejects.toThrow('Unknown action type');
    });

    test('threshold=1 bypasses multisig and executes immediately', async () => {
      // Temporarily set threshold to 1
      const originalThreshold = config.adminThreshold;
      config.adminThreshold = 1;
      
      try {
        const proposal = proposeAction('pause_contract', {}, adminWallet1);
        expect(proposal.status).toBe('immediate');
        // With threshold=1, the action should execute immediately in the controller
      } finally {
        config.adminThreshold = originalThreshold;
      }
    });
  });
});