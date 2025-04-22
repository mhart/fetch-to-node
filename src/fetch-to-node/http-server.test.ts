import { expect, test } from "vitest";
import { toFetchResponse, toReqRes } from "./http-server";

test("multiple set-cookie headers", async () => {
  const { res: nodeRes } = toReqRes(new Request("https://example.com"));

  // taken from https://nodejs.org/api/http.html#responsesetheadername-value
  nodeRes.setHeader("Set-Cookie", ["type=ninja", "language=javascript"]);
  nodeRes.writeHead(200);
  nodeRes.end();

  const webResponse = await toFetchResponse(nodeRes);
  expect(webResponse.headers.get("set-cookie")).toEqual(
    "type=ninja, language=javascript"
  );
});
