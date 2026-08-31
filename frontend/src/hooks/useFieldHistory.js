import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Undo/redo for the form builder canvas.
 *
 * Watches the `fields` array instead of wrapping every mutation, so any
 * setFields caller — property panel, drag, resize, delete, paste, stage
 * reordering — is undoable without touching the call site.
 *
 * Consecutive edits are coalesced into one entry so a drag or a burst of
 * typing undoes as a single action:
 *   - while a mouse gesture is active (isGestureActive), and
 *   - when the same field(s) are edited again within COALESCE_MS.
 * Structural changes (add / delete / paste / reorder) always start a new
 * entry: they change the id list, which never coalesces.
 */

const COALESCE_MS = 500
const HISTORY_LIMIT = 100

/** Ids present in both lists, in the same order — a property/geometry edit. */
function sameFieldIds(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
  }
  return true
}

/**
 * Ids whose field object was replaced between two same-shape lists.
 * Fields are updated immutably, so identity comparison is enough.
 */
function changedFieldIds(a, b) {
  const out = []
  const byId = new Map(a.map((f) => [f.id, f]))
  for (const f of b) {
    if (byId.get(f.id) !== f) out.push(f.id)
  }
  return out
}

function sameIdSet(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

export function useFieldHistory({
  fields,
  setFields,
  selectedIds,
  setSelectedIds,
  isGestureActive,
  onRestorePage,
}) {
  const pastRef = useRef([])
  const futureRef = useRef([])
  // Last state we have observed committed — the "before" image for the next edit.
  const prevRef = useRef({ fields, selectedIds })
  const lastPushAtRef = useRef(0)
  const lastChangedRef = useRef([])
  const gestureRef = useRef(false)
  // The exact array undo/redo is applying: that one commit is not recorded.
  // Holding the reference (rather than a boolean) matters — if React bails
  // out because the array is already current, no commit arrives, and a plain
  // flag would stay set and swallow the user's next real edit.
  const suppressRef = useRef(null)
  // Set by markBaseline: the next change starts a fresh history.
  const baselineRef = useRef(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const syncFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0)
    setCanRedo(futureRef.current.length > 0)
  }, [])

  /** Drop the history — used when a form is loaded or the canvas is reset. */
  const markBaseline = useCallback(() => {
    baselineRef.current = true
    pastRef.current = []
    futureRef.current = []
    lastPushAtRef.current = 0
    lastChangedRef.current = []
    syncFlags()
  }, [syncFlags])

  useEffect(() => {
    const prev = prevRef.current
    if (fields === prev.fields) {
      // Selection-only change: remember it so the next entry records the
      // selection as it was when the edit happened, but do not push.
      prevRef.current = { fields, selectedIds }
      return
    }

    if (suppressRef.current !== null) {
      const applied = suppressRef.current
      suppressRef.current = null
      if (fields === applied) {
        prevRef.current = { fields, selectedIds }
        return
      }
      // Not the undo/redo commit we were waiting for — record it normally.
    }

    if (baselineRef.current) {
      baselineRef.current = false
      prevRef.current = { fields, selectedIds }
      return
    }

    const now = Date.now()
    const gestureNow = !!isGestureActive?.()
    const gestureStarted = gestureNow && !gestureRef.current
    gestureRef.current = gestureNow

    const shapeKept = sameFieldIds(prev.fields, fields)
    const changed = shapeKept ? changedFieldIds(prev.fields, fields) : []
    const continuesBurst =
      pastRef.current.length > 0 &&
      (gestureNow
        ? // Mid-gesture: one entry for the whole drag/resize, whatever it touches.
          !gestureStarted
        : shapeKept &&
          sameIdSet(changed, lastChangedRef.current) &&
          now - lastPushAtRef.current < COALESCE_MS)

    if (!continuesBurst) {
      const next = pastRef.current.concat([{ fields: prev.fields, selectedIds: prev.selectedIds }])
      pastRef.current = next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
      futureRef.current = []
      lastChangedRef.current = changed
    }
    lastPushAtRef.current = now
    prevRef.current = { fields, selectedIds }
    syncFlags()
  }, [fields, selectedIds, isGestureActive, syncFlags])

  /** Move to `entry`, pushing the state we are leaving onto `oppositeRef`. */
  const applyEntry = useCallback(
    (entry) => {
      const current = prevRef.current
      suppressRef.current = entry.fields
      lastPushAtRef.current = 0
      lastChangedRef.current = []
      gestureRef.current = false
      prevRef.current = { fields: entry.fields, selectedIds: entry.selectedIds }

      // Follow the change to the page it happened on, so an undone delete
      // or edit is visible instead of silently applying off-screen.
      if (onRestorePage) {
        const currentById = new Map(current.fields.map((f) => [f.id, f]))
        const entryIds = new Set(entry.fields.map((f) => f.id))
        const touched =
          // a field coming back (undoing a delete), then one whose
          // properties differ, then one going away (undoing an add)
          entry.fields.find((f) => !currentById.has(f.id)) ||
          entry.fields.find((f) => currentById.get(f.id) !== f) ||
          current.fields.find((f) => !entryIds.has(f.id))
        if (touched?.page) onRestorePage(touched.page)
      }

      setFields(entry.fields)
      if (setSelectedIds) {
        setSelectedIds(new Set(entry.selectedIds ?? []))
      }
      syncFlags()
    },
    [onRestorePage, setFields, setSelectedIds, syncFlags],
  )

  const undo = useCallback(() => {
    const past = pastRef.current
    if (!past.length) return
    const entry = past[past.length - 1]
    pastRef.current = past.slice(0, -1)
    futureRef.current = futureRef.current.concat([
      { fields: prevRef.current.fields, selectedIds: prevRef.current.selectedIds },
    ])
    applyEntry(entry)
  }, [applyEntry])

  const redo = useCallback(() => {
    const future = futureRef.current
    if (!future.length) return
    const entry = future[future.length - 1]
    futureRef.current = future.slice(0, -1)
    pastRef.current = pastRef.current.concat([
      { fields: prevRef.current.fields, selectedIds: prevRef.current.selectedIds },
    ])
    applyEntry(entry)
  }, [applyEntry])

  return { undo, redo, canUndo, canRedo, markBaseline }
}
