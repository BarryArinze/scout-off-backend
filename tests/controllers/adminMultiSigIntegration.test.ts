/**
 * Integration tests for adminController multi-signature endpoints (#1017)
 * 
 * Tests the complete flow from HTTP request through multisig to execution
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../../src/app';
import { initDb, closeDb, getDriver } from '../../src/db';
import config from '../../src/config';
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

describe('Admin Multi-Signature Controller Integration', () => {
  const adminWallet1 = 'GADMIN1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const adminWallet2 = 'GADMIN2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const validatorWallet = 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const treasuryAddress = 'GTREASURYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeAll(async () => {
    config.adminThreshold = 2;
    config.adminWallets = [adminWallet1, adminWallet2];
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set successful responses
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

  describe('Complete multisig flows', () => {
    test('validator registration: propose → approve → execute', async () => {
      // Step 1: Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      expect(proposeResponse.body.success).toBe(true);
      expect(proposeResponse.body.data.actionId).toBeDefined();
      const actionId = proposeResponse.body.data.actionId;

      // Step 2: Second admin approves (reaches quorum and executes)
      const approveResponse = await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(200);

      expect(approveResponse.body.success).toBe(true);
      expect(approveResponse.body.message).toMatch(/action executed/i);
      
      // Verify stellar function was called
      expect(mockStellar.registerValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('validator revocation: propose → approve → execute', async () => {
      // Step 1: Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/validators/revoke')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // Step 2: Second admin approves
      const approveResponse = await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(200);

      expect(approveResponse.body.success).toBe(true);
      expect(mockStellar.revokeValidatorOnChain).toHaveBeenCalledWith(validatorWallet);
    });

    test('contract pause: propose → approve → execute', async () => {
      // Step 1: Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/contract/pause')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // Step 2: Second admin approves
      const approveResponse = await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(200);

      expect(approveResponse.body.success).toBe(true);
      expect(mockStellar.pauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
    });

    test('fee withdrawal: propose → approve → execute', async () => {
      // Step 1: Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/fees/withdraw')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ recipient: treasuryAddress, amount: '1000000' })
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // Step 2: Second admin approves
      const approveResponse = await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(200);

      expect(approveResponse.body.success).toBe(true);
      expect(mockStellar.withdrawFees).toHaveBeenCalledWith(treasuryAddress);
    });
  });

  describe('Error handling in HTTP layer', () => {
    test('duplicate approval returns 409 conflict', async () => {
      // Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/contract/pause')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // First approval succeeds
      await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(200);

      // Second approval from same admin should fail
      const duplicateResponse = await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(409);

      expect(duplicateResponse.body.success).toBe(false);
      expect(duplicateResponse.body.error).toMatch(/already signed/i);
    });

    test('execution failure returns 500 error', async () => {
      // Mock stellar operation to fail
      mockStellar.pauseContractOnChain.mockRejectedValue(new Error('Network timeout'));

      // Propose action
      const proposeResponse = await request(app)
        .post('/api/admin/contract/pause')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // Approval should fail due to execution error
      await request(app)
        .post(`/api/admin/actions/${actionId}/approve`)
        .set('Authorization', `Bearer ${adminWallet2}`)
        .expect(500);
    });

    test('invalid action ID returns 404', async () => {
      await request(app)
        .post('/api/admin/actions/invalid-action-id/approve')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(404);
    });

    test('unauthorized admin returns 403', async () => {
      const unauthorizedWallet = 'GUNAUTHORIZED123456789012345678901234567890123456';
      
      await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${unauthorizedWallet}`)
        .send({ validatorWallet })
        .expect(403);
    });
  });

  describe('Action listing and details', () => {
    test('can list pending actions', async () => {
      // Create a pending action
      await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      // List pending actions
      const response = await request(app)
        .get('/api/admin/actions')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].action_type).toBe('register_validator');
    });

    test('can get action details', async () => {
      // Create a pending action
      const proposeResponse = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${adminWallet1}`)
        .send({ validatorWallet })
        .expect(202);

      const actionId = proposeResponse.body.data.actionId;

      // Get action details
      const response = await request(app)
        .get(`/api/admin/actions/${actionId}`)
        .set('Authorization', `Bearer ${adminWallet1}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.action.id).toBe(actionId);
      expect(response.body.data.signatures).toHaveLength(1); // Just the proposer
    });
  });

  describe('Threshold behavior', () => {
    test('threshold=1 executes immediately', async () => {
      const originalThreshold = config.adminThreshold;
      config.adminThreshold = 1;

      try {
        // Should execute immediately, not create pending action
        const response = await request(app)
          .post('/api/admin/contract/pause')
          .set('Authorization', `Bearer ${adminWallet1}`)
          .expect(200); // Different status code for immediate execution

        // Should have called stellar function directly
        expect(mockStellar.pauseContractOnChain).toHaveBeenCalledWith(adminWallet1);
      } finally {
        config.adminThreshold = originalThreshold;
      }
    });

    test('higher threshold requires more approvals', async () => {
      const originalThreshold = config.adminThreshold;
      const originalAdmins = [...config.adminWallets];
      
      config.adminThreshold = 3;
      config.adminWallets = [adminWallet1, adminWallet2, 'GADMIN3XXXXXXXXX'];

      try {
        // Propose action
        const proposeResponse = await request(app)
          .post('/api/admin/contract/pause')
          .set('Authorization', `Bearer ${adminWallet1}`)
          .expect(202);

        const actionId = proposeResponse.body.data.actionId;

        // First approval - should remain pending
        const approve1 = await request(app)
          .post(`/api/admin/actions/${actionId}/approve`)
          .set('Authorization', `Bearer ${adminWallet2}`)
          .expect(202);

        expect(approve1.body.message).toMatch(/more signature/);
        expect(mockStellar.pauseContractOnChain).not.toHaveBeenCalled();

        // Second approval - should execute  
        const approve2 = await request(app)
          .post(`/api/admin/actions/${actionId}/approve`)
          .set('Authorization', 'Bearer GADMIN3XXXXXXXXX')
          .expect(200);

        expect(approve2.body.message).toMatch(/action executed/);
        expect(mockStellar.pauseContractOnChain).toHaveBeenCalled();
      } finally {
        config.adminThreshold = originalThreshold;
        config.adminWallets = originalAdmins;
      }
    });
  });
});