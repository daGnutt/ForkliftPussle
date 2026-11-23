export const VOTE_SECONDS = 20;
const RESULT_SECONDS = 4;

export function createVote() {
  let nextId = 0;
  let active = null;
  let result = null;

  function tally(v, status, now, eligible = false) {
    let yes = 0, no = 0;
    for (const choice of v.ballots.values()) {
      if (choice === 'yes') yes++;
      else no++;
    }
    return {
      id: v.id,
      action: v.action,
      status,
      yes,
      no,
      total: v.eligible.size,
      remaining: status === 'active' ? Math.max(0, v.deadline - now) : 0,
      eligible,
    };
  }

  function settle(status, now) {
    result = { ...tally(active, status, now), until: now + RESULT_SECONDS };
    active = null;
    return result;
  }

  function check(now) {
    if (!active) return null;
    const yes = [...active.ballots.values()].filter((choice) => choice === 'yes').length;
    const needed = Math.floor(active.eligible.size / 2) + 1;
    const undecided = active.eligible.size - active.ballots.size;
    if (yes >= needed) return settle('passed', now);
    if (yes + undecided < needed || now >= active.deadline) return settle('failed', now);
    return null;
  }

  return {
    start(action, voters, now) {
      if (active || voters.length === 0) return null;
      result = null;
      active = { id: ++nextId, action, eligible: new Set(voters), ballots: new Map(), deadline: now + VOTE_SECONDS };
      return this.state(now);
    },
    cast(id, voter, choice, now) {
      if (!active || active.id !== id || !active.eligible.has(voter) || !['yes', 'no'].includes(choice)) return null;
      active.ballots.set(voter, choice);
      check(now);
      return this.state(now, voter);
    },
    leave(voter, now) {
      if (!active || !active.eligible.delete(voter)) return null;
      active.ballots.delete(voter);
      check(now);
      return this.state(now);
    },
    cancel(now) {
      if (!active) return null;
      return settle('failed', now);
    },
    clear() { active = null; result = null; },
    poll(now) {
      check(now);
      if (result && now >= result.until) result = null;
      return this.state(now);
    },
    state(now, voter = null) {
      if (active) return tally(active, 'active', now, active.eligible.has(voter));
      if (result && now < result.until) {
        const { until, ...state } = result;
        return { ...state, eligible: false };
      }
      return null;
    },
  };
}
