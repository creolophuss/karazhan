#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { custodianSkills, medivhSkills, retiredSkill, digest, sha, files, makePackage, sourceVersion } from './scaffold-package.mjs';
import { discover } from './scaffold-discovery.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); };
const copy = (source, target) => { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); };
const usage = `Usage:
  node scripts/update-scaffolds.mjs prepare --out <private-directory> [--workspace <directory> ...] [--medivh-profile <directory> ...]
  node scripts/update-scaffolds.mjs apply --plan <private-directory>
Prepare discovers known targets when target flags are absent. It does not change targets.
Check targets to skip in TARGETS.md before the Agent composes candidates.
An LLM must compose/review each AGENTS candidate and fill review.json before apply.
No model is called. No Agent or App is restarted. No binaries are installed or built.
Default discovery may start the configured MCP companion for queries only.`;

function safeRoot(path) {
  if (!isAbsolute(path)) throw new Error(`Target must be absolute: ${path}`);
  if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error(`Missing directory or symlink target: ${path}`);
  const canonical = realpathSync(path);
  return canonical;
}
function inside(root, path) {
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes target: ${path}`);
  let current = full;
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in update path: ${current}`);
    current = dirname(current);
  }
  return full;
}
function manifest(root) {
  const text = readFileSync(inside(root, '.workbench/task.yaml'), 'utf8');
  const work = text.match(/^work:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] || '';
  const workspace = text.match(/^workspace:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] || '';
  function field(section, name) {
    const value = section.match(new RegExp(`^  ${name}:\\s*([^\\n#]+)`, 'm'))?.[1]?.trim();
    return value?.replace(/^['"]|['"]$/g, '');
  }
  const id = field(work, 'id'), path = field(workspace, 'path'), kind = field(work, 'kind');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '') || !['project', 'task'].includes(kind)) throw new Error(`Invalid Workspace identity: ${root}`);
  if (!path || !existsSync(path) || realpathSync(path) !== root) throw new Error(`Workspace manifest path mismatch: ${root}`);
  return { id, kind, title: field(work, 'title') };
}

function selectionRow(target) {
  const kind = target.kind === 'medivh' ? 'Medivh' : target.workKind === 'project' ? 'Project' : 'Task';
  const label = `${kind}${target.title ? ` · ${JSON.stringify(target.title)}` : ''} · ${JSON.stringify(target.path)}`;
  return `- [ ] 跳过更新：${label} <!-- target:${target.index} -->`;
}

function selectedTargets(out, plan) {
  if (plan.selectionFile === undefined) return plan.targets;
  if (plan.selectionFile !== 'TARGETS.md') throw new Error('Invalid target checklist path');
  const rows = readFileSync(join(out, plan.selectionFile), 'utf8').split(/\r?\n/);
  const choices = new Map(), targets = new Map(plan.targets.map(target => [target.index, target]));
  for (const line of rows) {
    if (!line.startsWith('- [')) continue;
    const match = line.match(/^- \[([ xX])\].*<!-- target:(\d+) -->$/);
    const index = match ? Number(match[2]) : null, target = targets.get(index);
    if (!target || choices.has(index) || line.replace(/^- \[[xX]\]/, '- [ ]') !== selectionRow(target)) {
      throw new Error('Invalid target checklist; only toggle the prepared checkboxes');
    }
    choices.set(index, match[1] === ' ');
  }
  if (choices.size !== plan.targets.length) throw new Error('Incomplete target checklist; prepare again or restore missing rows');
  return plan.targets.filter(target => choices.get(target.index));
}
function expectedLegacyPackage(path) {
  const packagePath = join(path, 'PACKAGE.md');
  if (!existsSync(packagePath)) return false;
  const expected = readFileSync(packagePath, 'utf8').match(/Skills digest \(SHA-256\): ([0-9a-f]{64})/)?.[1];
  const listed = readFileSync(packagePath, 'utf8').match(/Installed Skills: (.+)/)?.[1]?.split(', ').map(name => name.trim());
  if (!listed?.length || listed.some(name => ![...custodianSkills, retiredSkill].includes(name))) return false;
  const managedFiles = listed.flatMap(name => existsSync(join(path, name)) ? files(join(path, name)) : [] ).sort((a, b) => Buffer.compare(Buffer.from(relative(path, a)), Buffer.from(relative(path, b))));
  const manifest = managedFiles.map(file => `${sha(readFileSync(file))}  ./${relative(path, file)}\n`).join('');
  return expected && expected === sha(manifest) ? listed : false;
}
function targetLayout(kind) {
  const state = kind === 'custodian' ? '.workbench/scaffold-state.json' : '.karazhan-scaffold-state.json';
  const skills = kind === 'custodian' ? '.agents/skills' : 'skills/karazhan';
  const managed = ['AGENTS.md', ...(kind === 'medivh' ? ['SOUL.md'] : []), ...(kind === 'custodian' ? custodianSkills : medivhSkills).map(name => `${skills}/${name}`)];
  if (kind === 'custodian') managed.push(`${skills}/PACKAGE.md`);
  else managed.push('packages/custodian-startup-kit');
  return { state, skills, managed, retired: `${skills}/${retiredSkill}` };
}
function checkManaged(target, state, legacy, path) {
  const full = inside(target.path, path), actual = digest(full);
  if (actual === null) return;
  if (state?.installed?.[path] === actual) return;
  if (target.kind === 'custodian' && legacy && (path === '.agents/skills/PACKAGE.md' || legacy.includes(path.slice('.agents/skills/'.length).split('/')[0]))) return;
  if (target.kind === 'medivh') {
    const baseline = join(process.env.KARAZHAN_INSTALL_STATE_DIR || join(homedir(), '.local/share/karazhan-installer'), 'baseline/medivh', path.startsWith('skills/karazhan/') ? path.replace('skills/karazhan/', 'skills/') : path);
    if (existsSync(baseline) && readFileSync(baseline, 'utf8').trim() === actual) return;
  }
  // Already canonical content can safely be adopted without an older package.
  const source = path === 'SOUL.md' ? join(repository, 'blueprints/medivh/SOUL.md') : path.startsWith(target.layout.skills + '/') ? join(repository, 'blueprints/skills', path.slice(target.layout.skills.length + 1)) : null;
  if (source && existsSync(source) && digest(source) === actual) return;
  target.conflicts.push(`Unverified or locally modified managed content: ${path}`);
}

async function prepare(options) {
  const out = resolve(options.out || '');
  if (!options.out || existsSync(out)) throw new Error('--out must name a new private directory');
  if (!relative(repository, out).startsWith('..')) throw new Error('Keep the private plan outside the public repository');
  const version = sourceVersion(repository), sourceDigest = digest(join(repository, 'blueprints'));
  const discovery = await discover(options.workspace || [], options['medivh-profile'] || []);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  copy(join(repository, 'blueprints'), join(out, 'source/blueprints'));
  makePackage(repository, join(out, 'source/package'), version);
  const entries = [...discovery.found.map(entry => ({ ...entry, kind: 'custodian' })), ...discovery.profiles.map(path => ({ path, kind: 'medivh' }))];
  const targets = [], seen = new Map(), ids = new Map();
  for (const entry of entries) {
    let root;
    try { root = safeRoot(resolve(entry.path)); } catch (error) { discovery.warnings.push(error.message); continue; }
    if (seen.has(root)) {
      const prior = seen.get(root);
      if (prior.kind !== entry.kind || entry.work && prior.id !== entry.work) prior.conflicts.push('Conflicting target identity or target type');
      continue;
    }
    const target = { path: root, kind: entry.kind, id: null, conflicts: [], index: targets.length };
    target.layout = targetLayout(target.kind);
    const location = join(out, 'targets', String(target.index));
    mkdirSync(location, { recursive: true });
    try {
      if (target.kind === 'custodian') {
        const identity = manifest(root);
        target.id = identity.id;
        target.workKind = identity.kind;
        target.title = identity.title;
        if (entry.work && target.id !== entry.work) target.conflicts.push('Workspace identity does not match Karazhan binding');
        if (ids.has(target.id)) { target.conflicts.push('Duplicate Work ID at different directories'); ids.get(target.id).conflicts.push('Duplicate Work ID at different directories'); }
        ids.set(target.id, target);
      }
      const statePath = inside(root, target.layout.state), state = existsSync(statePath) ? json(statePath) : null;
      const legacy = target.kind === 'custodian' && existsSync(join(root, target.layout.skills)) && expectedLegacyPackage(join(root, target.layout.skills));
      const recordedVersion = state?.source?.version || (target.kind === 'custodian' && existsSync(join(root, target.layout.skills, 'PACKAGE.md')) ? readFileSync(join(root, target.layout.skills, 'PACKAGE.md'), 'utf8').match(/Install version: (\d+\.\d+\.\d+)/)?.[1] : null);
      if (recordedVersion) {
        const oldParts = recordedVersion.split('.').map(Number), newParts = version.version.split('.').map(Number);
        const firstDifference = newParts.findIndex((part, index) => part !== oldParts[index]);
        if (firstDifference >= 0 && newParts[firstDifference] < oldParts[firstDifference]) target.conflicts.push(`Refusing scaffold downgrade from ${recordedVersion} to ${version.version}`);
      }
      target.firstAdoption = !state;
      for (const path of target.layout.managed.filter(path => path !== 'AGENTS.md')) checkManaged(target, state, legacy, path);
      if (existsSync(inside(root, target.layout.retired))) {
        checkManaged(target, state, legacy, target.layout.retired);
        target.retire = !target.conflicts.some(message => message.includes(target.layout.retired));
      }
      // The kit is managed as a whole. Do not delete unknown additions within it.
      const referencePaths = target.kind === 'custodian' ? ['.workbench/task.yaml', 'context/requirements.md', 'context/index.md'] : [];
      const paths = [...target.layout.managed, target.layout.retired, target.layout.state, ...referencePaths];
      target.before = {};
      for (const path of paths) {
        const full = inside(root, path);
        target.before[path] = digest(full);
        if (existsSync(full)) copy(full, join(location, 'before', path));
      }
      const agents = inside(root, 'AGENTS.md');
      if (!existsSync(agents)) throw new Error('Existing AGENTS.md is required; update does not provision new targets');
      copy(agents, join(location, 'AGENTS.candidate.md'));
      const template = target.kind === 'custodian' ? 'blueprints/skills/workspace-provisioning/assets/custodian-AGENTS.md' : 'blueprints/medivh/AGENTS.md';
      copy(join(out, 'source', template), join(location, 'AGENTS.new-template.md'));
      const base = state?.template || (legacy ? readFileSync(join(root, target.layout.skills, 'workspace-provisioning/assets/custodian-AGENTS.md'), 'utf8') : null);
      if (base) {
        writeFileSync(join(location, 'AGENTS.base.md'), base);
        const merge = spawnSync('git', ['merge-file', '-p', agents, join(location, 'AGENTS.base.md'), join(location, 'AGENTS.new-template.md')], { encoding: 'utf8' });
        if (merge.status !== null && merge.status >= 0 && merge.status < 128) writeFileSync(join(location, 'AGENTS.merge-advisory.md'), merge.stdout);
      }
      save(join(location, 'review.json'), { reviewed: false, agentsSha256: null, notes: 'Compose the candidate from current instructions, the new template, and business requirements. Preserve business constraints. Review the diff, then set reviewed=true and agentsSha256 to the candidate SHA-256. This is the executing Agent review; no extra user approval is required.' });
    } catch (error) { target.conflicts.push(error.message); }
    seen.set(root, target); targets.push(target);
  }
  const plan = { schema: 1, repository, source: { ...version, digest: sourceDigest }, packageDigest: digest(join(out, 'source/package')), selectionFile: 'TARGETS.md', warnings: discovery.warnings, targets };
  save(join(out, 'plan.json'), plan);
  writeFileSync(join(out, 'TARGETS.md'), `# Choose update targets\n\nCheck a box to SKIP that target. Leave it unchecked to update. Each row is independent; skipping a Project does not skip its descendants. Toggle checkboxes only. Tell the executing Agent when selection is complete.\n\n${targets.map(selectionRow).join('\n')}\n`);
  writeFileSync(join(out, 'REVIEW.md'), `# Scaffold update review\n\nFirst present TARGETS.md to the user and wait for their selection. Checked boxes mean skip. Compose and review only the remaining targets. The script does not call a model. Review each candidate using its before/ snapshots and the new template. Automatic merge output is advisory. Preserve business constraints, identity, Context, Hooks, user data and unrelated Skills. Keep ASD-STE100 and free-form HTML guidance. Do not copy private material into the public repository.\n\nSelected targets with conflicts cannot be applied. Skip them or fix the underlying conflict and prepare a new plan. After editing each selected AGENTS.candidate.md, set reviewed=true and its SHA-256 in review.json. Then run apply --plan with this directory.\n\n${discovery.warnings.map(warning => `- ${warning}`).join('\n')}\n`);
  console.log(`Prepared ${targets.length} targets at ${out}. Choose skipped targets in TARGETS.md before composing candidates.`);
  for (const target of targets) console.log(`${target.kind}: ${target.path}${target.conflicts.length ? ` CONFLICT: ${target.conflicts.join('; ')}` : ''}`);
  for (const warning of discovery.warnings) console.error(`warning: ${warning}`);
}

function reviewedManagedFiles(out, target, review) {
  const replacements = new Map();
  const allowed = new Set([...target.layout.managed.filter(path => path !== 'AGENTS.md'), target.layout.retired]);
  for (const [path, resolution] of Object.entries(review.managed || {})) {
    if (!allowed.has(path) || review.reviewed !== true || !resolution.notes?.trim()
      || !Object.hasOwn(target.before, path) || resolution.beforeSha256 !== target.before[path]) {
      throw new Error(`Invalid managed content review: ${target.path}/${path}`);
    }
    if (resolution.action === 'retire' && path === target.layout.retired && target.before[path] !== null) {
      replacements.set(path, null);
    } else if (resolution.action === 'replace' && path !== target.layout.retired) {
      const candidate = inside(join(out, 'targets', String(target.index)), `managed-candidates/${path}`);
      if (!resolution.candidateSha256 || digest(candidate) !== resolution.candidateSha256) {
        throw new Error(`Managed candidate review is missing or stale: ${target.path}/${path}`);
      }
      replacements.set(path, candidate);
    } else throw new Error(`Invalid managed content action: ${path}`);
  }
  const unresolved = target.conflicts.filter(message => ![...replacements.keys()]
    .some(path => message === `Unverified or locally modified managed content: ${path}`));
  if (unresolved.length) throw new Error(`Plan has unresolved target conflicts: ${target.path}: ${unresolved.join('; ')}`);
  return replacements;
}

function replacementFiles(plan, out, target, reviewed) {
  const result = new Map(), location = join(out, 'targets', String(target.index));
  result.set('AGENTS.md', join(location, 'AGENTS.candidate.md'));
  if (target.kind === 'medivh') result.set('SOUL.md', join(out, 'source/blueprints/medivh/SOUL.md'));
  for (const skill of target.kind === 'custodian' ? custodianSkills : medivhSkills) result.set(`${target.layout.skills}/${skill}`, join(out, 'source/blueprints/skills', skill));
  if (target.kind === 'custodian') result.set(`${target.layout.skills}/PACKAGE.md`, join(out, 'source/package/PACKAGE.md'));
  else result.set('packages/custodian-startup-kit', join(out, 'source/kit'));
  if (target.retire) result.set(target.layout.retired, null);
  for (const [path, source] of reviewed) result.set(path, source);
  return result;
}

function apply(options) {
  if (!options.plan) throw new Error('--plan is required');
  const out = safeRoot(resolve(options.plan)), plan = json(join(out, 'plan.json'));
  if (plan.schema !== 1 || plan.repository !== repository) throw new Error('Invalid prepared plan');
  if (!plan.targets.length) throw new Error('No update targets were prepared');
  const targets = selectedTargets(out, plan);
  for (const target of plan.targets) if (!targets.includes(target)) console.log(`skipped: ${target.path}`);
  if (!targets.length) { console.log('No targets selected; nothing changed.'); return; }
  if (digest(join(repository, 'blueprints')) !== plan.source.digest || sourceVersion(repository).commit !== plan.source.commit) throw new Error('Stale source; prepare again');
  if (digest(join(out, 'source/blueprints')) !== plan.source.digest || digest(join(out, 'source/package')) !== plan.packageDigest) throw new Error('Source snapshot changed');
  const reviewed = new Map();
  for (const target of targets) {
    const reviewPath = join(out, 'targets', String(target.index), 'review.json');
    reviewed.set(target.index, reviewedManagedFiles(out, target, existsSync(reviewPath) ? json(reviewPath) : {}));
  }
  // Recreate only the private package staging area, never a target.
  rmSync(join(out, 'source/kit'), { recursive: true, force: true });
  copy(join(out, 'source/package'), join(out, 'source/kit/.agents/skills'));
  const results = existsSync(join(out, 'applied.json')) ? json(join(out, 'applied.json')) : {};
  // Validate every target and every review before changing the first target.
  for (const target of targets) {
    if (safeRoot(target.path) !== target.path || target.kind === 'custodian' && manifest(target.path).id !== target.id) throw new Error(`Stale identity: ${target.path}`);
    // Never trust arbitrary write paths in an edited plan.
    if (JSON.stringify(target.layout) !== JSON.stringify(targetLayout(target.kind))) throw new Error('Invalid prepared write paths');
    const review = json(join(out, 'targets', String(target.index), 'review.json'));
    const candidate = join(out, 'targets', String(target.index), 'AGENTS.candidate.md');
    const text = readFileSync(candidate, 'utf8');
    if (review.reviewed !== true || review.agentsSha256 !== digest(candidate)) throw new Error(`AGENTS review is missing or stale: ${target.path}`);
    if (/^(<<<<<<<|>>>>>>>|=======$)/m.test(text)) throw new Error('Candidate contains merge conflict markers');
    if (!text.includes('ASD-STE100') || text.includes('answer-me-with-html')) throw new Error('Candidate must retain ASD-STE100 and remove the retired Skill instruction');
    const expected = results[target.path] || target.before;
    for (const [path, baseline] of Object.entries(expected)) if (digest(inside(target.path, path)) !== baseline) throw new Error(`Stale target content: ${target.path}/${path}`);
  }
  for (const target of targets) {
    const replacements = replacementFiles(plan, out, target, reviewed.get(target.index));
    const managedReviews = json(join(out, 'targets', String(target.index), 'review.json')).managed || {};
    const state = { schema: 1, source: plan.source, template: readFileSync(join(out, 'source', target.kind === 'custodian' ? 'blueprints/skills/workspace-provisioning/assets/custodian-AGENTS.md' : 'blueprints/medivh/AGENTS.md'), 'utf8'), installed: {} };
    if (Object.keys(managedReviews).length) state.managedReviews = managedReviews;
    for (const [path, source] of replacements) state.installed[path] = source ? digest(source) : null;
    const stateSource = join(out, 'targets', String(target.index), 'state.next.json'); save(stateSource, state);
    replacements.set(target.layout.state, stateSource);
    if ([...replacements].every(([path, source]) => digest(inside(target.path, path)) === (source ? digest(source) : null))) {
      console.log(`no-op: ${target.path}`); continue;
    }
    const backup = join(out, 'backups', String(target.index));
    if (existsSync(backup)) throw new Error(`Backup already exists; inspect the prior apply: ${backup}`);
    mkdirSync(backup, { recursive: true });
    const present = [];
    for (const path of replacements.keys()) if (existsSync(inside(target.path, path))) { copy(inside(target.path, path), join(backup, path)); present.push(path); }
    save(join(backup, 'present.json'), present);
    const changed = [];
    const stagedPaths = [];
    try {
      // Stage every replacement before changing the first destination.
      for (const [path, source] of replacements) {
        const destination = inside(target.path, path);
        if (!source || digest(source) === digest(destination)) continue;
        const staged = `${destination}.karazhan-update-${process.pid}`;
        if (existsSync(staged)) throw new Error(`Staging path exists: ${staged}`);
        stagedPaths.push(staged);
        copy(source, staged);
      }
      for (const [path, source] of replacements) {
        const destination = inside(target.path, path);
        if (source && digest(source) === digest(destination) || !source && !existsSync(destination)) continue;
        const staged = `${destination}.karazhan-update-${process.pid}`;
        changed.push(path);
        rmSync(destination, { recursive: true, force: true });
        if (source) renameSync(staged, destination);
      }
      for (const [path, source] of replacements) if (digest(inside(target.path, path)) !== (source ? digest(source) : null)) throw new Error(`Verification failed: ${path}`);
      results[target.path] = Object.fromEntries(Object.keys(target.before).map(path => [path, digest(inside(target.path, path))]));
      save(join(out, 'applied.json'), results);
      console.log(`updated: ${target.path}`);
    } catch (error) {
      for (const staged of stagedPaths) rmSync(staged, { recursive: true, force: true });
      for (const path of changed.reverse()) {
        rmSync(inside(target.path, path), { recursive: true, force: true });
        if (present.includes(path)) copy(join(backup, path), inside(target.path, path));
      }
      throw new Error(`Restored failed target ${target.path}: ${error.message}`);
    }
  }
  console.log('Reload Agent instructions before continuing. Agents were not restarted. Backups remain private in the plan directory.');
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, plan: { type: 'string' }, workspace: { type: 'string', multiple: true }, 'medivh-profile': { type: 'string', multiple: true }, help: { type: 'boolean' } } });
  if (values.help) console.log(usage);
  else if (positionals[0] === 'prepare') await prepare(values);
  else if (positionals[0] === 'apply') apply(values);
  else throw new Error(usage);
} catch (error) { console.error(`karazhan update: ${error.message}`); process.exitCode = 1; }
