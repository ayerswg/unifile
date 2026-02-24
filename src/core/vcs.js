/**
 * Unifile Version Control System
 *
 * A git-inspired VCS embedded inside a single HTML file.
 * All data is plain JSON, suitable for inclusion in a <script> tag.
 *
 * Concepts:
 *   commit       – snapshot of a document at a point in time, stored as a diff
 *   branch       – named pointer to the tip of a line of commits
 *   tag          – optional SemVer label on a commit
 *   detachedHead – viewing a historical commit without being on a branch tip;
 *                  committing from here requires naming a new branch first
 */

import { computePatch, applyPatch, computeBlame } from './diff.js';
import { commitHash, shortHash } from './hash.js';

export class VCS {
  /**
   * @param {object} data – the unifile data object (branches, commits, currentBranch)
   */
  constructor(data) {
    this.branches = data.branches ?? { main: { name: 'main', head: null } };
    this.commits = data.commits ?? {};
    this.currentBranch = data.currentBranch ?? 'main';
    /**
     * When non-null we are in "detached HEAD" state: we're viewing a historical
     * commit that is not the tip of any branch. No branch head is modified until
     * the user names a new branch and creates a commit.
     * @type {string|null}
     */
    this.detachedHead = data.detachedHead ?? null;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * The hash we are currently viewing, regardless of branch state.
   * When detached, this is the historical commit hash.
   */
  get headHash() {
    return this.detachedHead ?? this.branches[this.currentBranch]?.head ?? null;
  }

  get headCommit() {
    return this.headHash ? this.commits[this.headHash] : null;
  }

  /** True when viewing a historical commit that is not a branch tip. */
  get isDetached() {
    return this.detachedHead !== null;
  }

  /**
   * Reconstruct document content at a given commit hash.
   * Traverses ancestor chain and applies patches in order.
   * @param {string|null} hash
   * @returns {string}
   */
  getContentAt(hash) {
    if (!hash) return '';
    const commit = this.commits[hash];
    if (!commit) return '';

    // Root commit – stores full content
    if (commit.fullContent !== undefined) {
      return commit.fullContent;
    }

    // Recursive: reconstruct parent, then apply patch
    const parentContent = this.getContentAt(commit.parent);
    return applyPatch(parentContent, commit.patch);
  }

  /** Current head content */
  get headContent() {
    return this.getContentAt(this.headHash);
  }

  /**
   * Return an ordered array of commit objects from the root to `hash`.
   * @param {string|null} hash
   * @returns {object[]}
   */
  getAncestorChain(hash) {
    const chain = [];
    let h = hash;
    while (h && this.commits[h]) {
      chain.unshift(this.commits[h]);
      h = this.commits[h].parent ?? null;
    }
    return chain;
  }

  /**
   * Find the most recent common ancestor of two commits.
   * @param {string} hashA
   * @param {string} hashB
   * @returns {string|null}
   */
  findCommonAncestor(hashA, hashB) {
    const ancestorsA = new Set();
    let h = hashA;
    while (h) {
      ancestorsA.add(h);
      h = this.commits[h]?.parent ?? null;
    }

    h = hashB;
    while (h) {
      if (ancestorsA.has(h)) return h;
      h = this.commits[h]?.parent ?? null;
    }
    return null;
  }

  /**
   * Return all commits reachable from `hash` that are NOT reachable from `base`.
   * (i.e. commits introduced since `base` on the path leading to `hash`)
   * @param {string} hash
   * @param {string|null} base
   * @returns {object[]} oldest first
   */
  commitsSince(hash, base) {
    const chain = [];
    let h = hash;
    while (h && h !== base && this.commits[h]) {
      chain.unshift(this.commits[h]);
      h = this.commits[h].parent ?? null;
    }
    return chain;
  }

  /**
   * Compute blame for the current head.
   * @returns {Array<{ line: string, commitHash: string }>}
   */
  blame() {
    const chain = this.getAncestorChain(this.headHash);
    return computeBlame(chain);
  }

  /**
   * List all branches with their head info.
   * @returns {Array<{ name, head, headCommit }>}
   */
  listBranches() {
    return Object.values(this.branches).map(b => ({
      name: b.name,
      head: b.head,
      headCommit: b.head ? this.commits[b.head] : null,
      isCurrent: b.name === this.currentBranch
    }));
  }

  /**
   * Return an ordered commit log for a branch (newest first).
   * @param {string} [branchName]
   * @returns {object[]}
   */
  log(branchName) {
    const b = branchName ?? this.currentBranch;
    const head = this.branches[b]?.head;
    return this.getAncestorChain(head).reverse();
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Create a new commit on the current branch (or a named branch when detached).
   *
   * When in detached HEAD state a `branchName` MUST be provided. The VCS will
   * automatically create that branch at the current detached commit and switch
   * to it before creating the new commit. This preserves the full history of
   * every existing branch unchanged.
   *
   * @param {object} opts
   * @param {string} opts.content    – new document content
   * @param {string} opts.message    – commit message
   * @param {string} opts.author     – author display name
   * @param {string} opts.email      – author email
   * @param {string} [opts.tag]      – optional SemVer tag
   * @param {string} [opts.branchName] – required when isDetached, names the new branch
   * @returns {Promise<string>}      – new commit hash
   */
  async commit({ content, message, author, email, tag, branchName }) {
    // ── Detached HEAD: materialise a real branch before committing ────────────
    if (this.isDetached) {
      if (!branchName) {
        const err = new Error(
          'Cannot commit in detached HEAD state without a branch name. ' +
          'Please provide a name for the new branch.'
        );
        err.code = 'DETACHED_HEAD';
        throw err;
      }
      this.createBranch(branchName, this.detachedHead);
      this.currentBranch = branchName;
      this.detachedHead = null;
    }

    // ── Normal commit ─────────────────────────────────────────────────────────
    const parent = this.headHash;
    const timestamp = Date.now();

    let patch = null;
    let fullContent = undefined;

    if (parent === null) {
      // Root commit – store full content
      fullContent = content;
    } else {
      const parentContent = this.getContentAt(parent);
      patch = computePatch(parentContent, content);
    }

    const hash = await commitHash({ parent, message, author, email, timestamp, patch });

    const commitObj = {
      hash,
      parent,
      branch: this.currentBranch,
      message,
      author,
      email,
      timestamp,
      tag: tag || null,
      patch,
      ...(fullContent !== undefined ? { fullContent } : {})
    };

    this.commits[hash] = commitObj;
    this.branches[this.currentBranch].head = hash;
    return hash;
  }

  /**
   * Check out a historical commit, entering detached HEAD state.
   *
   * Branch history is NEVER modified. When the user later makes changes and
   * tries to commit, the commit dialog will ask for a new branch name.
   *
   * If `newBranchName` is supplied (e.g. from explicit "create branch here"
   * action), we create the branch and switch immediately instead of detaching.
   *
   * @param {string} hash
   * @param {string} [newBranchName] – if provided, create+switch branch instead of detaching
   * @returns {{ content: string, branchName: string }}
   */
  checkout(hash, newBranchName) {
    if (!this.commits[hash]) throw new Error(`Commit ${hash} not found`);

    if (newBranchName) {
      // Explicit branch creation at this commit
      this.createBranch(newBranchName, hash);
      this.currentBranch = newBranchName;
      this.detachedHead = null;
    } else {
      // Enter detached HEAD state — no branch is touched
      this.detachedHead = hash;
    }

    return {
      content: this.getContentAt(hash),
      branchName: this.currentBranch
    };
  }

  /**
   * Create a new branch pointing at `hash` (defaults to current head).
   * @param {string} name
   * @param {string|null} [hash]
   */
  createBranch(name, hash) {
    if (this.branches[name]) throw new Error(`Branch "${name}" already exists`);
    this.branches[name] = {
      name,
      head: hash ?? this.headHash
    };
  }

  /**
   * Switch to an existing branch (clears detached HEAD state).
   * @param {string} name
   * @returns {string} content at head of that branch
   */
  switchBranch(name) {
    if (!this.branches[name]) throw new Error(`Branch "${name}" does not exist`);
    this.currentBranch = name;
    this.detachedHead = null;
    return this.headContent;
  }

  /**
   * Import commits from an external data object (another quine).
   * All imported commits are added; the caller must create a merge branch.
   *
   * @param {object} externalData – the full unifile data from the imported quine
   * @returns {{ commonAncestor: string|null, importedBranch: string }}
   */
  importFrom(externalData, importBranchName) {
    const extVcs = new VCS(externalData);

    // Add all commits we don't already have
    for (const [hash, commit] of Object.entries(extVcs.commits)) {
      if (!this.commits[hash]) {
        this.commits[hash] = { ...commit };
      }
    }

    // Add all external branches with a prefix to avoid collisions
    for (const [name, branch] of Object.entries(extVcs.branches)) {
      const importedName = `${importBranchName}/${name}`;
      if (!this.branches[importedName]) {
        this.branches[importedName] = { name: importedName, head: branch.head };
      }
    }

    // Find common ancestor between our head and their head
    const ourHead = this.headHash;
    const theirHead = extVcs.headHash;
    const ancestor = this.findCommonAncestor(ourHead, theirHead);

    return { commonAncestor: ancestor, importedHead: theirHead };
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  /**
   * Return a plain object suitable for embedding in the quine data.
   */
  serialize() {
    return {
      branches: this.branches,
      commits: this.commits,
      currentBranch: this.currentBranch,
      detachedHead: this.detachedHead
    };
  }
}
