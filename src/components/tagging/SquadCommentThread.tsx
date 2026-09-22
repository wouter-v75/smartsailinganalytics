'use client'

// The squad's conversation about one tagged moment, inside the tag sheet.
//
// WHY IT LIVES HERE. A coach watching a squad partner's tack wants to say
// something about THAT tack, at that second, not in a message thread somewhere
// else with a timestamp typed by hand. The tag is already the shared reference;
// the comment belongs on it.
//
// WHAT IT SHOWS AND WHY:
//   • the author's team beside their name, always. The point of the feature is
//     somebody from ANOTHER team commenting, and rendering their words like
//     your own crew's throws away the one bit of context that matters.
//   • partner comments marked, for the same reason.
//   • a delete button only on your own, because that is all the policy allows
//     (0074) — a button that 403s is worse than no button.
//   • "could not load" rather than an empty thread when the fetch fails. An
//     empty thread is what a broken policy looks like, and that ambiguity hid
//     the whole squad feature for a day.
//
// The composer is absent, not disabled, when the viewer has no team to speak
// for or the squad shares no comments: there is nothing they could do about it
// and a greyed-out box invites a support question.

import * as React from 'react'
import { MessageSquare, Trash2, Send } from 'lucide-react'
import {
  loadComments, addComment, deleteComment, canDelete, authorLine, isFromPartner,
  type CommentsState, type SquadComment,
} from '@/lib/squadComments'

export interface SquadCommentThreadProps {
  tagId: string
  /** The team the viewer is speaking for — their active workspace's team. */
  authorTeamId?: string | null
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

const when = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : ''
}

export default function SquadCommentThread({
  tagId, authorTeamId, fetchImpl,
}: SquadCommentThreadProps) {
  const [state, setState] = React.useState<CommentsState | null>(null)
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setState(await loadComments(tagId, fetchImpl))
  }, [tagId, fetchImpl])

  React.useEffect(() => { void refresh() }, [refresh])

  // 0074 is not applied, so there is no such thing as a squad comment yet.
  // Say nothing at all rather than showing an empty feature.
  if (state?.kind === 'unavailable') return null

  const comments: SquadComment[] = state?.kind === 'ok' ? state.comments : []
  const viewerId = state?.kind === 'ok' ? state.viewerId : null

  async function submit() {
    if (!authorTeamId || !draft.trim() || busy) return
    setBusy(true); setErr(null)
    const res = await addComment(tagId, authorTeamId, draft, fetchImpl)
    if (res.ok) { setDraft(''); await refresh() } else setErr(res.error)
    setBusy(false)
  }

  async function remove(id: string) {
    setBusy(true); setErr(null)
    const res = await deleteComment(tagId, id, fetchImpl)
    if (!res.ok) setErr(res.error || 'could not delete that')
    await refresh()
    setBusy(false)
  }

  return (
    <div className="mt-3 border-t border-slate-700 pt-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-400 mb-2">
        <MessageSquare className="w-3.5 h-3.5" />
        Squad comments
        {comments.length > 0 && <span className="text-slate-500">· {comments.length}</span>}
      </div>

      {state === null && <div className="text-xs text-slate-500">Loading…</div>}

      {state?.kind === 'error' && (
        // NOT an empty thread. See the header.
        <div className="text-xs text-amber-400">
          Could not load comments — {state.message}.
        </div>
      )}

      {state?.kind === 'ok' && comments.length === 0 && (
        <div className="text-xs text-slate-500">
          Nothing said yet.
        </div>
      )}

      <ul className="space-y-2">
        {comments.map((c) => (
          <li key={c.id} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="text-slate-300 text-xs font-medium">{authorLine(c)}</span>
              {isFromPartner(c) && (
                <span className="text-[9px] uppercase tracking-wide bg-cyan-500/20 text-cyan-300 px-1 py-0.5 rounded">
                  squad
                </span>
              )}
              <span className="text-[10px] text-slate-500">{when(c.created_at)}</span>
              {canDelete(c, viewerId) && (
                <button
                  onClick={() => remove(c.id)}
                  disabled={busy}
                  title="Delete your comment"
                  className="ml-auto text-slate-500 hover:text-red-400 disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="text-slate-200 whitespace-pre-wrap break-words">{c.body}</div>
          </li>
        ))}
      </ul>

      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}

      {authorTeamId && state?.kind === 'ok' && (
        <div className="mt-2 flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. A coach types one line
              // on a phone in a RIB and should not hunt for a button.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() }
            }}
            rows={2}
            placeholder="Say something about this moment…"
            className="flex-1 text-sm bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-slate-100 placeholder:text-slate-500 resize-none"
          />
          <button
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="shrink-0 p-2 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-40"
            title="Post"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
