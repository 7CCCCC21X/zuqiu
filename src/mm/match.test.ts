import test from "node:test";
import assert from "node:assert/strict";
import { detectOutcome, normalizeName, rankEvents, teamMatches } from "./match";
import type { OddsEvent } from "../types";

test("normalizeName strips accents and punctuation", () => {
  assert.equal(normalizeName("Atlético de Madrid"), "atletico de madrid");
  assert.equal(normalizeName("Brighton & Hove Albion"), "brighton and hove albion");
});

test("teamMatches handles suffixes and aliases", () => {
  assert.ok(teamMatches("Arsenal", "Will Arsenal FC win against Chelsea?"));
  assert.ok(teamMatches("Manchester United", "Man Utd vs Liverpool"));
  assert.ok(teamMatches("Tottenham Hotspur", "Spurs to win"));
  assert.ok(!teamMatches("Manchester United", "Manchester City vs Everton"));
  assert.ok(teamMatches("Shanghai Port", "Shanghai Port FC v Beijing Guoan", { "shanghai port fc": "shanghai port" }));
});

test("detectOutcome reads draw / home / away from titles", () => {
  const teams = { home: "Arsenal", away: "Chelsea" };
  assert.equal(detectOutcome("Arsenal vs Chelsea: Draw", teams), "draw");
  assert.equal(detectOutcome("Will Arsenal win?", teams), "home");
  assert.equal(detectOutcome("Will Chelsea beat Arsenal?", teams), "away");
  assert.equal(detectOutcome("Arsenal vs Chelsea - Chelsea to win", teams), "away");
  assert.equal(detectOutcome("Arsenal vs Chelsea - Arsenal to win", teams), "home");
  assert.equal(detectOutcome("Arsenal vs Chelsea", teams), undefined);
});

test("rankEvents prefers events matching both teams", () => {
  const mk = (id: string, h: string, a: string, t: number): OddsEvent => ({ id, sportKey: "s", commenceTime: t, homeTeam: h, awayTeam: a, bookmakers: [], fetchedAt: 0 });
  const events = [mk("1", "Arsenal", "Chelsea", 2000), mk("2", "Arsenal", "Everton", 1000), mk("3", "Liverpool", "Chelsea", 1500)];
  const ranked = rankEvents("Will Arsenal win vs Chelsea?", events, {});
  assert.equal(ranked[0]?.event.id, "1");
  assert.equal(ranked[0]?.score, 2);
  assert.equal(ranked.length, 3);
});
