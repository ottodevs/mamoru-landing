/** Writes the War room with fixture numbers as a full /ops document: `bun scripts/war-room-preview.ts [out.html]`. */
import { renderDocument } from "../src/ops";
import { warRoomSection } from "../src/war-room";
import { warRoomFixture } from "../test/war-room-fixture";

const out = process.argv[2] ?? "war-room.html";
await Bun.write(out, renderDocument(warRoomSection(warRoomFixture()), { csrf: "preview", who: "operator@example.test", nonce: "preview" }));
console.log(`wrote ${out}`);
