import axios from "axios";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

async function test() {
  const cidStr = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"; // this is just a dummy from tests, let's find a real one
  // let's fetch a real public cid if possible, or we can just mock it.
  
  const content = Buffer.from(JSON.stringify({ age: 20 }));
  const hash = await sha256.digest(content);
  const cidRaw = CID.createV1(raw.code, hash);
  console.log("Raw CID:", cidRaw.toString());

  // Let's check how the test expects it.
}
test().catch(console.error);
