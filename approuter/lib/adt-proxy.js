"use strict";

// Mounted on the approuter at `/adt-proxy` (see ../start.js). It is the cloud
// half of the on-prem reach: adt-cli sends plain
// `/sap/bc/adt/*` calls here carrying only `Authorization: Bearer <userJwt>`;
// this handler resolves the named BTP destination with that user JWT and lets
// the SAP Cloud SDK tunnel the request through the connectivity proxy with a
// Cloud-Connector-issued SAML assertion (principal propagation). adt-cli stays
// "dumb": it never sees XSUAA, destinations or the connectivity service.
//
// Multi-destination: the destination name is the first path segment, so one
// proxy serves every connection in the subaccount:
//   /adt-proxy/<DEST>/sap/bc/adt/...   ->  destination <DEST> + /sap/bc/adt/...
//
// Ported from the proven local test harness `adt-cli-router/index.js`; the only
// changes are the dynamic `:dest` segment and stripping the mount prefix. Header
// casing, the raw request body and the response byte array are preserved so the
// finicky ADT protocol (CSRF tokens, cookies, binary source) survives intact.
// "Preserved" here has to hold for Content-Types that are not valid media types
// either - see the body parser below; ADT sends one of those on every create.

const express = require("express");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const { getDestination } = require("@sap-cloud-sdk/connectivity");

const app = express();

// Capture the whole body as a raw buffer so ADT payloads are never corrupted.
//
// The `type` option MUST stay a predicate. A string pattern (even `"*/*"`) routes
// the decision through type-is -> media-typer, and media-typer throws on
// `application/*` - the exact Content-Type every ADT create endpoint requires
// (adt-cli mirrors abap-adt-api here, and SAP itself accepts it). A rejected type
// makes body-parser skip the stream and leave `req.body = {}`, which axios then
// serialises to the two bytes `{}`; SAP's sXML reads that as JSON and answers
// "System expected the element ...abapProgram, XML_PATH object(1)". The predicate
// bypasses type-is entirely, so every byte survives whatever the client declared.
app.use(express.raw({ type: () => true, limit: "50mb" }));

app.all("/:dest/sap/bc/adt/*", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send("Missing Bearer token");
    }
    const userJwt = authHeader.slice("Bearer ".length).trim();

    const destinationName = req.params.dest;
    if (!destinationName) {
      return res.status(400).send("Missing destination name in path");
    }

    // 1. Exchange the BTP user token for an on-prem connection to this destination.
    const destination = await getDestination({
      destinationName,
      jwt: userJwt,
      useCache: true,
    });
    if (!destination) {
      return res.status(404).send(`Destination "${destinationName}" not found`);
    }

    // 2. The ADT path is everything after `/adt-proxy/<dest>` (query preserved).
    const target = req.originalUrl.replace(/^\/adt-proxy\/[^/]+/, "");

    // 3. Forward request headers but PRESERVE casing (Cookie, X-CSRF-Token, ...).
    //    Drop hop-by-hop / auth headers the SDK manages itself.
    const cleanedHeaders = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const lower = key.toLowerCase();
      if (["host", "authorization", "content-length", "connection"].includes(lower)) continue;
      cleanedHeaders[key] = req.rawHeaders[i + 1];
    }

    // 4. Tunnel to the on-prem system via the connectivity proxy. Keep the byte
    //    array intact (binary source) and do not let the SDK fetch a CSRF token.
    //    Only ever forward a real Buffer: anything else (notably body-parser's
    //    `{}` placeholder) would be JSON-stringified by axios and reach SAP as a
    //    two-byte body instead of the XML. An empty buffer is no body at all -
    //    a bodyless POST (lock/unlock) must not grow a payload here.
    const contentType = cleanedHeaders["Content-Type"] || cleanedHeaders["content-type"] || "none";
    const isBodyless = req.method === "GET" || req.method === "HEAD";
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    if (!isBodyless && rawBody === null) {
      // Unreachable while the parser above uses a predicate; logged so that a
      // silent regression back to a string `type` cannot hide again.
      console.error(
        `[adt-proxy] ${req.method} ${target}: raw body missing (content-type: ${contentType}) - ` +
          "body parser skipped this request, payload would be lost",
      );
    }
    const hasBody = !isBodyless && rawBody !== null && rawBody.length > 0;
    console.log(
      `[adt-proxy] ${req.method} ${target} body=${hasBody ? rawBody.length : 0}B ct=${contentType}`,
    );
    const response = await executeHttpRequest(
      destination,
      {
        method: req.method,
        url: target,
        headers: cleanedHeaders,
        data: hasBody ? rawBody : undefined,
        responseType: "arraybuffer",
      },
      { fetchCsrfToken: false },
    );

    // 5. Relay status, headers and raw body back to adt-cli.
    res.status(response.status);
    if (response.headers) {
      for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
    }
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error("[adt-proxy] forwarding error:", error && error.message ? error.message : error);
    const status = error && error.response ? error.response.status : 500;
    const data =
      error && error.response
        ? Buffer.from(error.response.data || "")
        : String((error && error.message) || "Internal proxy error");
    res.status(status).send(data);
  }
});

module.exports = app;
