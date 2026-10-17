import type { TerminalSession, Workspace } from '../../domain/models';
import { DEFAULT_WORKSPACE_TITLE } from '../../domain/sessionTabTitle';
import {
  collectSessionIds,
  createGridWorkspaceFromSessionIds,
  pruneWorkspaceNode,
} from '../../domain/workspace';
import { replaceDissolvedWorkspaceTabOrder } from './sessionWorkspaceDetach';

export type SplitAllConnectedSessionsStateResult = {
  changed: boolean;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  /** Id of the newly created workspace; the caller should activate its tab. */
  workspaceId?: string;
};

/**
 * Collect every connected, non-hidden session into one new grid workspace.
 *
 * Sessions already living in another workspace are pulled out of its tree:
 * a workspace that keeps ≥2 panes shrinks in place, one left with a single
 * pane dissolves (the survivor returns to a standalone tab, taking over the
 * workspace's tab slot), and a fully-collected workspace disappears. The new
 * workspace's tab takes the position of the first tab removed from the bar.
 */
export function splitAllConnectedSessionsState({
  sessions,
  workspaces,
  tabOrder,
}: {
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  tabOrder: readonly string[];
}): SplitAllConnectedSessionsStateResult {
  const candidates = sessions.filter(
    (session) => session.status === 'connected' && !session.hiddenFromTabs,
  );
  if (candidates.length < 2) {
    return { changed: false, sessions: [...sessions], workspaces: [...workspaces], tabOrder: [...tabOrder] };
  }

  const candidateIds = new Set(candidates.map((session) => session.id));
  const workspace = createGridWorkspaceFromSessionIds(
    candidates.map((session) => session.id),
    { title: DEFAULT_WORKSPACE_TITLE, viewMode: 'split' },
  );

  const nextWorkspaces: Workspace[] = [];
  const dissolvedWorkspaceIds = new Set<string>();
  const dissolvedReplacements: Array<{ workspaceId: string; replacementTabIds: string[] }> = [];

  for (const sourceWorkspace of workspaces) {
    const collectedIds = collectSessionIds(sourceWorkspace.root).filter((id) => candidateIds.has(id));
    if (collectedIds.length === 0) {
      nextWorkspaces.push(sourceWorkspace);
      continue;
    }

    let prunedRoot = sourceWorkspace.root;
    for (const sessionId of collectedIds) {
      prunedRoot = pruneWorkspaceNode(prunedRoot, sessionId);
    }

    if (!prunedRoot) {
      dissolvedWorkspaceIds.add(sourceWorkspace.id);
      continue;
    }

    const remainingSessionIds = collectSessionIds(prunedRoot);
    if (remainingSessionIds.length === 1) {
      dissolvedWorkspaceIds.add(sourceWorkspace.id);
      dissolvedReplacements.push({
        workspaceId: sourceWorkspace.id,
        replacementTabIds: remainingSessionIds,
      });
      continue;
    }

    const nextFocusedSessionId = remainingSessionIds.includes(sourceWorkspace.focusedSessionId)
      ? sourceWorkspace.focusedSessionId
      : remainingSessionIds[0];
    const nextFocusSessionOrder = (sourceWorkspace.focusSessionOrder ?? [])
      .filter((candidateId, index, list) => (
        remainingSessionIds.includes(candidateId) &&
        list.indexOf(candidateId) === index
      ));
    for (const remainingSessionId of remainingSessionIds) {
      if (!nextFocusSessionOrder.includes(remainingSessionId)) {
        nextFocusSessionOrder.push(remainingSessionId);
      }
    }

    nextWorkspaces.push({
      ...sourceWorkspace,
      root: prunedRoot,
      focusedSessionId: nextFocusedSessionId,
      focusSessionOrder: nextFocusSessionOrder,
    });
  }

  nextWorkspaces.push(workspace);

  // Survivors of dissolved 2-pane workspaces lose their binding and return
  // to standalone tabs; collected sessions rebind to the new workspace.
  const unboundIds = new Set(dissolvedReplacements.flatMap(({ replacementTabIds }) => replacementTabIds));
  const nextSessions = sessions.map((session) => {
    if (candidateIds.has(session.id)) return { ...session, workspaceId: workspace.id };
    if (unboundIds.has(session.id)) return { ...session, workspaceId: undefined };
    return session;
  });

  let nextTabOrder = [...tabOrder];
  for (const { workspaceId, replacementTabIds } of dissolvedReplacements) {
    nextTabOrder = replaceDissolvedWorkspaceTabOrder(nextTabOrder, workspaceId, replacementTabIds);
  }
  const emptiedWorkspaceIds = [...dissolvedWorkspaceIds].filter(
    (id) => !dissolvedReplacements.some(({ workspaceId }) => workspaceId === id),
  );
  const removedTabIds = new Set([...candidateIds, ...emptiedWorkspaceIds]);
  nextTabOrder = nextTabOrder.filter((id) => !removedTabIds.has(id));

  // Insert the new tab where the first removed tab used to be (in the
  // original order — ids before that index are untouched by the filter).
  const firstRemovedIndex = tabOrder.findIndex((id) => removedTabIds.has(id));
  if (firstRemovedIndex >= 0) {
    nextTabOrder.splice(Math.min(firstRemovedIndex, nextTabOrder.length), 0, workspace.id);
  } else {
    nextTabOrder.push(workspace.id);
  }

  return {
    changed: true,
    sessions: nextSessions,
    workspaces: nextWorkspaces,
    tabOrder: nextTabOrder,
    workspaceId: workspace.id,
  };
}

export type DissolveWorkspaceIntoTabsStateResult = {
  changed: boolean;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  /** First freed session in tree order; the caller should activate its tab. */
  activeTabId?: string;
};

/**
 * Inverse of `splitAllConnectedSessionsState` for one workspace: dissolve it
 * and return every pane session to a standalone tab. The freed tabs take over
 * the workspace's slot in the tab order (tree order), keeping sessions and
 * their connection state untouched.
 */
export function dissolveWorkspaceIntoTabsState({
  sessions,
  workspaces,
  tabOrder,
  workspaceId,
}: {
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  tabOrder: readonly string[];
  workspaceId: string;
}): DissolveWorkspaceIntoTabsStateResult {
  const targetWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!targetWorkspace) {
    return { changed: false, sessions: [...sessions], workspaces: [...workspaces], tabOrder: [...tabOrder] };
  }

  const freedSessionIds = collectSessionIds(targetWorkspace.root);
  const freedIds = new Set(freedSessionIds);

  const nextSessions = sessions.map((session) => (
    freedIds.has(session.id) ? { ...session, workspaceId: undefined } : session
  ));
  const nextWorkspaces = workspaces.filter((workspace) => workspace.id !== workspaceId);
  const nextTabOrder = replaceDissolvedWorkspaceTabOrder(tabOrder, workspaceId, freedSessionIds);

  return {
    changed: true,
    sessions: nextSessions,
    workspaces: nextWorkspaces,
    tabOrder: nextTabOrder,
    activeTabId: freedSessionIds[0],
  };
}
