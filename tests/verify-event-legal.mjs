#!/usr/bin/env node
/* Deterministic source checks for the event-specific legal materials. No network calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const read = (name) => readFile(path.join(app, name), "utf8");
const [terms, privacy, media, index, guest, chain, config, legalCss] = await Promise.all([
  read("event-terms.html"), read("event-privacy.html"), read("media-release.html"), read("index.html"),
  read("guest-registration.js"), read("live-chain.js"), read("config.js"), read("legal-pages.css"),
]);
const legalPages = [terms, privacy, media];
const localLinks = ["./event-terms.html", "./event-privacy.html", "./media-release.html"];

for (const [name, source] of [["event terms", terms], ["event privacy", privacy], ["media release", media]]) {
  assert.match(source, /SALUTE Foundation/, `${name} must name the organizer`);
  assert.match(source, /12 East 49th Street, 11th Floor[\s\S]*New York, NY 10017/, `${name} must include the organizer address`);
  assert.match(source, /ssuite@salute\.community/, `${name} must include the event contact route`);
  assert.match(source, /Friday, November 20, 2026/, `${name} must state the event date`);
  assert.match(source, /Prince George Ballroom/, `${name} must state the venue`);
  assert.match(source, /legal-pages\.css/, `${name} must use the shared legal-page styling`);
  for (const link of localLinks) assert.match(source, new RegExp(link.replace(".", "\\.")), `${name} must link to ${link}`);
}
assert.match(terms, /start time has not yet been confirmed/i);
assert.match(terms, /verified/i);
assert.match(terms, /Stripe/);
assert.match(terms, /Purchases are final except in the event of cancellation, duplicate charge, a legal requirement, or a written exception approved by SALUTE Foundation/);
assert.match(terms, /November 13, 2026/);
assert.match(terms, /Resale is prohibited/);
assert.match(terms, /purchaser’s authorization for those included guests/i);
assert.match(terms, /manually registered[\s\S]*personally agrees/i);
assert.match(privacy, /supplemental event notice/i);
assert.match(privacy, /this Event Privacy Notice prevails/i);
assert.match(privacy, /https:\/\/www\.salute\.community\/privacy-policy/);
for (const item of ["name", "email", "job title", "company", "meal preference", "dietary", "accessibility", "referral", "transaction", "consent", "technical"]) assert.match(privacy.toLowerCase(), new RegExp(item));
for (const processor of ["Stripe", "Supabase", "Klaviyo"]) assert.match(privacy, new RegExp(processor));
assert.match(privacy, /SMS is disabled/i);
assert.match(privacy, /do not sell personal information/i);
assert.match(privacy, /reasonable period tied to event operations/i);
assert.match(media, /photo(graph|graphy), video, and audio/i);
assert.match(media, /accessibility need or privacy concern/i);
assert.match(media, /does not create a separate media opt-out/i);
for (const forbidden of ["arbitration", "class action waiver", "governing law", "tax-deductible"]) {
  for (const source of legalPages) assert.doesNotMatch(source.toLowerCase(), new RegExp(forbidden), `legal pages must not invent ${forbidden}`);
}
assert.match(index, /name="combined_agreement"/);
assert.match(index, /I agree to the[\s\S]*Event Terms &amp; Conditions[\s\S]*Event Privacy Notice[\s\S]*Media, Photo &amp; Video Release/);
assert.doesNotMatch(index, /data-policy-link="(?:terms|privacy|media)" href="#"/, "public registration legal links cannot be placeholders");
for (const link of localLinks) {
  assert.match(index, new RegExp(`href="${link.replace(".", "\\.")}"`), `public registration must use ${link}`);
  assert.match(guest, new RegExp(link.replace(".", "\\.")), `private registration must use ${link}`);
  assert.match(chain, new RegExp(link.replace(".", "\\.")), `live chain must preserve ${link}`);
}
assert.doesNotMatch(guest, /\["Terms & Conditions", p\.termsUrl\]/, "private registration cannot replace event legal pages with a configured placeholder");
assert.match(guest, /name = "combined_agreement"/);
assert.match(config, /mode:\s*"preview"/, "adding legal pages must not enable sales");
assert.match(legalCss, /@font-face/);
console.log("event legal source verification passed");
