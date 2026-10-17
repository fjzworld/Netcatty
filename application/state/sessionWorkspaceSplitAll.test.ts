import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSession, Workspace, WorkspaceNode } from '../../domain/models';
import { collectSessionIds } from '../../domain/workspace';
import { dissolveWorkspaceIntoTabsState, splitAllConnectedSessionsState } from './sessionWorkspaceSplitAll';

type SessionOverrides = Partial<Pick<TerminalSession, 'status' | 'workspaceId' | 'hiddenFromTabs'>>;

const session = (id: string, overrides: SessionOverrides = {}): TerminalSession => ({
  id,
  hostId: `host-${id}`,
  hostLabel: `Host ${id}`,
  hostname: `${id}.example.test`,
  username: 'user',
  status: 'connected',
  protocol: 'ssh',
  workspaceId: undefined,
  ...overrides,
});

const flatRoot = (sessionIds: string[]): WorkspaceNode => ({
  id: `split-${sessionIds.join('-')}`,
  type: 'split',
  direction: 'vertical',
  sizes: sessionIds.map(() => 1 / sessionIds.length),
  children: sessionIds.map((sessionId) => ({
    id: `pane-${sessionId}`,
    type: 'pane' as const,
    sessionId,
  })),
});

const workspace = (id: string, sessionIds: string[], focusedSessionId?: string): Workspace => ({
  id,
  title: `WS ${id}`,
  viewMode: 'split',
  focusedSessionId: focusedSessionId ?? sessionIds[0],
  focusSessionOrder: [...sessionIds],
  root: flatRoot(sessionIds),
});

test('splitAllConnectedSessionsState is a no-op with fewer than two connected sessions', () => {
  const sessions = [session('s1'), session('s2', { status: 'disconnected' })];
  const workspaces = [workspace('ws-1', ['s2'])];
  const result = splitAllConnectedSessionsState({ sessions, workspaces, tabOrder: ['s1', 'ws-1'] });

  assert.equal(result.changed, false);
  assert.equal(result.workspaceId, undefined);
  assert.deepEqual(result.sessions, sessions);
  assert.deepEqual(result.workspaces, workspaces);
  assert.deepEqual(result.tabOrder, ['s1', 'ws-1']);
});

test('splitAllConnectedSessionsState collects standalone sessions into one grid workspace', () => {
  const sessions = [session('s1'), session('s2'), session('s3')];
  const result = splitAllConnectedSessionsState({ sessions, workspaces: [], tabOrder: ['s1', 's2', 's3'] });

  assert.equal(result.changed, true);
  assert.ok(result.workspaceId);
  assert.deepEqual(collectSessionIds(result.workspaces[result.workspaces.length - 1].root), ['s1', 's2', 's3']);
  assert.ok(result.sessions.every((s) => s.workspaceId === result.workspaceId));
  assert.deepEqual(result.tabOrder, [result.workspaceId]);
  assert.equal(result.workspaces[result.workspaces.length - 1].viewMode, 'split');
});

test('splitAllConnectedSessionsState skips hidden and non-connected sessions', () => {
  const sessions = [
    session('s1'),
    session('s2'),
    session('s3', { hiddenFromTabs: true }),
    session('s4', { status: 'connecting' }),
  ];
  const result = splitAllConnectedSessionsState({ sessions, workspaces: [], tabOrder: ['s1', 's2'] });

  assert.equal(result.changed, true);
  const collected = collectSessionIds(result.workspaces[result.workspaces.length - 1].root);
  assert.deepEqual(collected, ['s1', 's2']);
  const byId = new Map(result.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s3')?.hiddenFromTabs, true);
  assert.equal(byId.get('s3')?.workspaceId, undefined);
  assert.equal(byId.get('s4')?.status, 'connecting');
  assert.equal(byId.get('s4')?.workspaceId, undefined);
});

test('splitAllConnectedSessionsState dissolves a workspace left with a single pane and frees the survivor', () => {
  // ws-1 holds s1 (connected, collected), s2 (connected, collected) and
  // s3 (disconnected, stays) — after collection only s3 remains, so ws-1
  // dissolves and s3 returns to a standalone tab in ws-1's slot.
  const sessions = [
    session('s1', { workspaceId: 'ws-1' }),
    session('s2', { workspaceId: 'ws-1' }),
    session('s3', { workspaceId: 'ws-1', status: 'disconnected' }),
    session('s4'),
  ];
  const workspaces = [workspace('ws-1', ['s1', 's2', 's3'])];
  const result = splitAllConnectedSessionsState({ sessions, workspaces, tabOrder: ['ws-1', 's4'] });

  assert.equal(result.changed, true);
  assert.ok(!result.workspaces.some((ws) => ws.id === 'ws-1'));
  assert.equal(result.workspaces.length, 1);

  const byId = new Map(result.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s3')?.workspaceId, undefined);
  assert.equal(byId.get('s3')?.status, 'disconnected');
  // ws-1's slot becomes s3's standalone tab; s4 was collected into the new
  // workspace, so the new tab lands in s4's old position after s3.
  assert.deepEqual(result.tabOrder, ['s3', result.workspaceId]);
});

test('splitAllConnectedSessionsState shrinks a workspace that keeps multiple panes', () => {
  // ws-1 holds four sessions; s1 and s2 are connected and get collected,
  // s5 and s6 are disconnected and stay — the workspace survives with two
  // panes and keeps its tab.
  const sessions = [
    session('s1', { workspaceId: 'ws-1' }),
    session('s2', { workspaceId: 'ws-1' }),
    session('s5', { workspaceId: 'ws-1', status: 'disconnected' }),
    session('s6', { workspaceId: 'ws-1', status: 'disconnected' }),
  ];
  const workspaces = [workspace('ws-1', ['s1', 's2', 's5', 's6'], 's2')];
  const result = splitAllConnectedSessionsState({ sessions, workspaces, tabOrder: ['ws-1'] });

  const shrunk = result.workspaces.find((ws) => ws.id === 'ws-1');
  assert.ok(shrunk);
  assert.deepEqual(collectSessionIds(shrunk.root), ['s5', 's6']);
  assert.equal(shrunk.focusedSessionId, 's5');
  assert.deepEqual(shrunk.focusSessionOrder, ['s5', 's6']);

  const byId = new Map(result.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s5')?.workspaceId, 'ws-1');
  assert.equal(byId.get('s6')?.workspaceId, 'ws-1');
  assert.equal(result.tabOrder.length, 2);
  assert.ok(result.tabOrder.includes('ws-1'));
});

test('splitAllConnectedSessionsState replaces a fully collected workspace tab with the new tab in place', () => {
  // Only ws-1's sessions are connected, so ws-1 is emptied and removed; the
  // new workspace tab takes over ws-1's slot in the tab order.
  const sessions = [
    session('s9', { status: 'disconnected' }),
    session('s1', { workspaceId: 'ws-1' }),
    session('s2', { workspaceId: 'ws-1' }),
    session('s7', { status: 'disconnected' }),
  ];
  const workspaces = [workspace('ws-1', ['s1', 's2'])];
  const result = splitAllConnectedSessionsState({
    sessions,
    workspaces,
    tabOrder: ['s9', 's7', 'ws-1'],
  });

  assert.ok(!result.workspaces.some((ws) => ws.id === 'ws-1'));
  assert.deepEqual(result.tabOrder, ['s9', 's7', result.workspaceId]);
});

test('splitAllConnectedSessionsState inserts the new tab at the first collected tab position', () => {
  const sessions = [session('s1'), session('s2'), session('s8', { status: 'disconnected' })];
  const result = splitAllConnectedSessionsState({
    sessions,
    workspaces: [],
    tabOrder: ['vault', 's8', 's1', 's2'],
  });

  assert.deepEqual(result.tabOrder, ['vault', 's8', result.workspaceId]);
});

test('dissolveWorkspaceIntoTabsState returns every pane to a standalone tab in the same slot', () => {
  const sessions = [
    session('s9', { status: 'disconnected' }),
    session('s1', { workspaceId: 'ws-1' }),
    session('s2', { workspaceId: 'ws-1' }),
    session('s3', { workspaceId: 'ws-1', status: 'disconnected' }),
    session('s7'),
  ];
  const workspaces = [workspace('ws-1', ['s1', 's2', 's3'])];
  const result = dissolveWorkspaceIntoTabsState({
    sessions,
    workspaces,
    tabOrder: ['s9', 'ws-1', 's7'],
    workspaceId: 'ws-1',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.tabOrder, ['s9', 's1', 's2', 's3', 's7']);
  assert.equal(result.activeTabId, 's1');
  assert.ok(!result.workspaces.some((ws) => ws.id === 'ws-1'));

  const byId = new Map(result.sessions.map((s) => [s.id, s]));
  assert.equal(byId.get('s1')?.workspaceId, undefined);
  assert.equal(byId.get('s2')?.workspaceId, undefined);
  assert.equal(byId.get('s3')?.workspaceId, undefined);
  assert.equal(byId.get('s3')?.status, 'disconnected');
  assert.equal(byId.get('s7')?.workspaceId, undefined);
  assert.equal(byId.get('s9')?.workspaceId, undefined);
});

test('dissolveWorkspaceIntoTabsState is a no-op for an unknown workspace id', () => {
  const sessions = [session('s1', { workspaceId: 'ws-1' })];
  const workspaces = [workspace('ws-1', ['s1'])];
  const result = dissolveWorkspaceIntoTabsState({
    sessions,
    workspaces,
    tabOrder: ['ws-1'],
    workspaceId: 'ws-missing',
  });

  assert.equal(result.changed, false);
  assert.equal(result.activeTabId, undefined);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.tabOrder.length, 1);
});

test('dissolveWorkspaceIntoTabsState also frees a single-pane workspace', () => {
  const sessions = [session('s1', { workspaceId: 'ws-1' })];
  const result = dissolveWorkspaceIntoTabsState({
    sessions,
    workspaces: [workspace('ws-1', ['s1'])],
    tabOrder: ['ws-1'],
    workspaceId: 'ws-1',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.tabOrder, ['s1']);
  assert.equal(result.activeTabId, 's1');
  assert.equal(result.sessions[0].workspaceId, undefined);
});
