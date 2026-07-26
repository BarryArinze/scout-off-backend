import request from "supertest";
import jwt from "jsonwebtoken";

import app from "../../src/app";

const SECRET = process.env.JWT_SECRET ?? "test-secret";

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: "1h" });
}

// Keep consistent with other tests
const PLAYER_WALLET = "G" + "A".repeat(55);
const ADMIN_WALLET = "G" + "B".repeat(55);

// Ensure we use real DB in this suite (no jest.mock for src/db)

describe("Player profile history", () => {
  it("accumulates across multiple PUT updates and GET returns version list (admin)", async () => {
    const adminToken = makeToken(ADMIN_WALLET, "admin");
    const playerToken = makeToken(PLAYER_WALLET, "player");

    // Stub updateProfile to return different tx hashes + metadata URIs.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stellar = require("../../src/services/stellar");
    const updateProfileSpy = jest
      .spyOn(stellar, "updateProfile")
      .mockImplementationOnce(async () => ({
        transactionId: "tx-1",
        metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      }))
      .mockImplementationOnce(async () => ({
        transactionId: "tx-2",
        metadataUri: "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
      }));

    // Ensure base player exists in DB via register endpoint.
    // This endpoint expects either `metadata` (pins to IPFS) or `metadataUri`.
    // To avoid IPFS side effects, mock pinJson.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ipfs = require("../../src/services/ipfs");
    jest.spyOn(ipfs, "pinJson").mockResolvedValue("QmMetaPinned");
    jest
      .spyOn(ipfs, "gatewayUrl")
      .mockImplementation((cid: unknown) => `https://gateway/${cid}`);

    // Mock webhook dispatch so test doesn't fail.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const webhooks = require("../../src/services/webhooks");
    jest.spyOn(webhooks, "dispatchEventWebhook").mockResolvedValue(undefined);

    const registerRes = await request(app)
      .post("/api/players/register")
      .set("Authorization", `Bearer ${playerToken}`)
      .send({
        wallet: PLAYER_WALLET,
        position: "striker",
        region: "europe",
        metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.success).toBe(true);

    // 1st update
    const put1 = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set("Authorization", `Bearer ${playerToken}`)
      .send({ metadataUri: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });

    expect(put1.status).toBe(200);
    expect(put1.body.success).toBe(true);

    // 2nd update
    const put2 = await request(app)
      .put(`/api/players/${PLAYER_WALLET}`)
      .set("Authorization", `Bearer ${playerToken}`)
      .send({ metadataUri: "QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64" });

    expect(put2.status).toBe(200);
    expect(put2.body.success).toBe(true);

    // history
    const historyRes = await request(app)
      .get(`/api/players/${PLAYER_WALLET}/history`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.success).toBe(true);

    const history = historyRes.body.data;
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(2);

    // Newest first (changed_at desc)
    expect(history[0].metadataUri).toBe("QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64");
    expect(history[0].txHash).toBe("tx-2");
    expect(history[1].metadataUri).toBe("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    expect(history[1].txHash).toBe("tx-1");

    updateProfileSpy.mockRestore();
  });
});
