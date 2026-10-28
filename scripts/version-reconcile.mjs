import { nextVersion, releaseKind, validateState } from './version-policy.mjs';

/** The adapter owns a disposable checkout; snapshots are always refreshed from main. */
export async function reconcile(adapter, { maxConflicts = 5 } = {}) {
  let published = 0;
  let conflicts = 0;
  for (;;) {
    const { state, version, pulls } = await adapter.snapshot();
    validateState(state, version);
    // History is a prefix of main's first-parent merge order. Never insert a missed
    // decision before an already published version or reinterpret a recorded label.
    for (const [index, entry] of state.processed.entries()) {
      if (pulls[index]?.number !== entry.pr || pulls[index]?.mergeCommit !== entry.mergeCommit) {
        throw new Error('Recorded history disagrees with main merge order');
      }
    }
    const pull = pulls[state.processed.length];
    if (!pull) return published;
    const details = adapter.describe ? await adapter.describe(pull) : pull;
    const kind = releaseKind(details.labels, details.files);
    const entry = { pr: pull.number, mergeCommit: pull.mergeCommit, kind, version: nextVersion(version, kind) };
    const updated = { ...state, processed: [...state.processed, entry] };
    validateState(updated, entry.version);
    await adapter.apply(entry, updated);
    await adapter.verify();
    await adapter.commit(entry);
    if (await adapter.push()) {
      published++;
      conflicts = 0;
    } else if (++conflicts >= maxConflicts) {
      throw new Error('Too many concurrent main changes; rerun versioning');
    }
  }
}
