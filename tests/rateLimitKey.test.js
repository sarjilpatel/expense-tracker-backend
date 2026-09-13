// The rate limiter's bucket key (W3-01). It used to be the IP alone, which made a family on one
// router share a single 60/min budget; a signed-in request now counts against its user.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "s".repeat(32);
const { rateLimitKey } = require("../utils/rateLimitKey");

const req = (authorization, ip = "203.0.113.7") => ({ headers: authorization ? { authorization } : {}, ip });

test("a verified bearer token keys on the user id", () => {
    const token = jwt.sign({ id: "user-1" }, process.env.JWT_SECRET);
    assert.equal(rateLimitKey(req(`Bearer ${token}`)), "user:user-1");
});

test("two users on one IP get two buckets; two devices of one user share one", () => {
    const a = jwt.sign({ id: "alice" }, process.env.JWT_SECRET);
    const b = jwt.sign({ id: "bob" }, process.env.JWT_SECRET);
    assert.notEqual(rateLimitKey(req(`Bearer ${a}`, "10.0.0.2")), rateLimitKey(req(`Bearer ${b}`, "10.0.0.2")));
    assert.equal(rateLimitKey(req(`Bearer ${a}`, "10.0.0.2")), rateLimitKey(req(`Bearer ${a}`, "198.51.100.9")));
});

test("no token falls back to the IP", () => {
    assert.equal(rateLimitKey(req(undefined, "203.0.113.7")), "ip:203.0.113.7");
});

test("a forged or expired token does not earn its own bucket", () => {
    const forged  = jwt.sign({ id: "mallory" }, "not-the-secret");
    const expired = jwt.sign({ id: "alice" }, process.env.JWT_SECRET, { expiresIn: -10 });
    assert.equal(rateLimitKey(req(`Bearer ${forged}`, "203.0.113.7")),  "ip:203.0.113.7");
    assert.equal(rateLimitKey(req(`Bearer ${expired}`, "203.0.113.7")), "ip:203.0.113.7");
});

test("IPv6 addresses collapse to their subnet so one client cannot rotate through a /64", () => {
    const one = rateLimitKey(req(undefined, "2001:db8:85a3:8d3:1319:8a2e:370:7348"));
    const two = rateLimitKey(req(undefined, "2001:db8:85a3:8d3:ffff:ffff:ffff:ffff"));
    assert.equal(one, two);
});
