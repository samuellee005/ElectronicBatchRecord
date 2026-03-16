import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  PencilSquareIcon,
  CalendarIcon,
  HashtagIcon,
  PencilIcon,
  DocumentTextIcon,
  ChevronUpDownIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import PdfViewer from '../components/PdfViewer'
import { listForms, loadFormById, saveForm } from '../api/client'
import './FormBuilder.css'

const COMPONENT_TYPES = [
  { type: 'text', Icon: PencilSquareIcon, name: 'Text Entry' },
  { type: 'date', Icon: CalendarIcon, name: 'Date Entry' },
  { type: 'number', Icon: HashtagIcon, name: 'Number Entry' },
  { type: 'signature', Icon: PencilIcon, name: 'Signature' },
  { type: 'textarea', Icon: DocumentTextIcon, name: 'Text Area' },
  { type: 'dropdown', Icon: ChevronUpDownIcon, name: 'Dropdown' },
  { type: 'checkbox', Icon: CheckIcon, name: 'Checkbox' },
]

const DEFAULT_CONFIGS = {
  text: { width: 200, height: 35, label: 'Text Field', placeholder: 'Enter text' },
  date: { width: 200, height: 35, label: 'Date Field', placeholder: 'Select date' },
  number: { width: 200, height: 35, label: 'Number Field', placeholder: 'Enter number', unit: '' },
  signature: { width: 300, height: 100, label: 'Signature Field', placeholder: 'Sign here' },
  textarea: { width: 300, height: 100, label: 'Text Area', placeholder: 'Enter text' },
  dropdown: { width: 200, height: 35, label: 'Dropdown Field', options: ['Option 1', 'Option 2'] },
  checkbox: { width: 150, height: 30, label: 'Checkbox Field' },
}

const UNIT_OPTIONS = ['', 'kg', 'g', 'mg', 'L', 'mL', '\u00B0C', '\u00B0F', '%', 'ppm', 'pH']

const SNAP_THRESHOLD = 5
const RULER_TICK_INTERVAL = 50
const RULER_LABEL_INTERVAL = 100
const RULER_SIZE = 24
// Scale at which field coordinates are stored; overlay positions scale with zoom
const DESIGN_SCALE = 1.5

function formatDate(dateString) {
  if (!dateString) return 'Unknown'
  const d = new Date(dateString)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function FormBuilder() {
  const [searchParams] = useSearchParams()
  const pdfFile = searchParams.get('file')
  const urlFormId = searchParams.get('formId')
  const urlName = searchParams.get('name')

  const pdfRef = useRef(null)
  const overlayRef = useRef(null)

  const [fields, setFields] = useState([])
  const [selectedFieldId, setSelectedFieldId] = useState(null)
  const [scale, setScale] = useState(1.5)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [sourceFormIds, setSourceFormIds] = useState([])
  const [loadedFormName, setLoadedFormName] = useState(urlName || null)

  // Modal states
  const [showSelectionModal, setShowSelectionModal] = useState(true)
  const [selectionMode, setSelectionMode] = useState(null)
  const [availableForms, setAvailableForms] = useState([])
  const [selectionFormId, setSelectionFormId] = useState(null)
  const [formsLoading, setFormsLoading] = useState(true)

  const [showSaveModal, setShowSaveModal] = useState(false)
  const [allFormNames, setAllFormNames] = useState([])
  const [allFormsData, setAllFormsData] = useState([])
  const [saveFormName, setSaveFormName] = useState('')
  const [saveFormNameNew, setSaveFormNameNew] = useState('')
  const [saveFormNameMode, setSaveFormNameMode] = useState('select')
  const [saveDescription, setSaveDescription] = useState('')
  const [saveUserName, setSaveUserName] = useState('')
  const [saveSelectedFormId, setSaveSelectedFormId] = useState('')
  const [saveCreateNewVersion, setSaveCreateNewVersion] = useState(false)
  const [saving, setSaving] = useState(false)
  const [componentsPanelCollapsed, setComponentsPanelCollapsed] = useState(false)

  // Drag/resize state via refs to avoid re-renders during drag
  const dragState = useRef({ active: false, fieldId: null, offsetX: 0, offsetY: 0 })
  const resizeState = useRef({ active: false, fieldId: null, startX: 0, startY: 0, startW: 0, startH: 0 })

  // Alignment guides (snap to other fields)
  const [guides, setGuides] = useState([])
  // Position guidelines (dragged field edges for ruler alignment)
  const [positionGuides, setPositionGuides] = useState(null)

  const selectedField = useMemo(
    () => fields.find((f) => f.id === selectedFieldId) || null,
    [fields, selectedFieldId],
  )

  const scaleFactor = scale / DESIGN_SCALE

  // Load available forms on mount
  useEffect(() => {
    if (!pdfFile) return
    setFormsLoading(true)
    listForms()
      .then((data) => {
        if (data.success && data.forms) {
          const forPdf = data.forms.filter((f) => f.pdfFile === pdfFile)
          setAvailableForms(forPdf)
          if (forPdf.length === 0) {
            setSelectionMode('new')
          }
        }
      })
      .catch(() => {})
      .finally(() => setFormsLoading(false))
  }, [pdfFile])

  // If formId in URL, skip modal and load directly
  useEffect(() => {
    if (urlFormId && pdfFile) {
      setShowSelectionModal(false)
      loadFormById(urlFormId).then((data) => {
        if (data.success && data.form?.fields) {
          setLoadedFormName(data.form.name || null)
          setSourceFormIds(data.form.sourceFormIds?.length ? data.form.sourceFormIds : [urlFormId])
          setFields(data.form.fields.map((f) => ({ ...f, page: f.page || 1 })))
        }
      })
    }
  }, [urlFormId, pdfFile])

  // Pre-fill user name from localStorage
  useEffect(() => {
    try {
      const name = localStorage.getItem('ebrUserDisplayName')
      if (name) setSaveUserName(name)
    } catch {}
  }, [])

  const handlePageRendered = useCallback(({ page, width, height, totalPages: n }) => {
    setCurrentPage(page)
    setCanvasSize({ width, height })
    if (n != null) setTotalPages(n)
  }, [])

  const goToPrevPage = () => pdfRef.current?.changePage(-1)
  const goToNextPage = () => pdfRef.current?.changePage(1)

  // Zoom handlers
  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3.0))
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5))
  const resetZoom = () => setScale(1.5)

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
        else if (e.key === '-') { e.preventDefault(); zoomOut() }
        else if (e.key === '0') { e.preventDefault(); resetZoom() }
      }
      if (e.key === 'Escape') {
        if (showSaveModal) setShowSaveModal(false)
      }
      if (e.key === 'Delete' && selectedFieldId) {
        setFields((prev) => prev.filter((f) => f.id !== selectedFieldId))
        setSelectedFieldId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showSaveModal, selectedFieldId])

  // Ctrl+scroll zoom on canvas
  const handleCanvasWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      if (e.deltaY < 0) setScale((s) => Math.min(s + 0.25, 3.0))
      else setScale((s) => Math.max(s - 0.25, 0.5))
    }
  }, [])

  // -- Field CRUD --

  const addField = useCallback((type, pixelX, pixelY, page) => {
    const config = DEFAULT_CONFIGS[type] || DEFAULT_CONFIGS.text
    const designX = (pixelX * DESIGN_SCALE) / scale
    const designY = (pixelY * DESIGN_SCALE) / scale
    const maxDesignX = (canvasSize.width * DESIGN_SCALE) / scale - config.width
    const maxDesignY = (canvasSize.height * DESIGN_SCALE) / scale - config.height
    const newField = {
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      type,
      page,
      x: Math.max(0, Math.min(designX, maxDesignX)),
      y: Math.max(0, Math.min(designY, maxDesignY)),
      width: config.width,
      height: config.height,
      label: config.label,
      required: false,
      stageInProcess: '',
      stageOrder: null,
      placeholder: config.placeholder || '',
      unit: config.unit ?? '',
      options: config.options ? [...config.options] : undefined,
    }
    setFields((prev) => [...prev, newField])
    setSelectedFieldId(newField.id)
  }, [canvasSize, scale])

  const updateField = useCallback((id, updates) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)))
  }, [])

  const deleteField = useCallback((id) => {
    setFields((prev) => prev.filter((f) => f.id !== id))
    setSelectedFieldId((prev) => (prev === id ? null : prev))
  }, [])

  // -- Snap logic --

  const snapToAlignment = useCallback((pixelX, pixelY, fieldId, fieldWidth, fieldHeight, scaleFactor) => {
    let snappedX = pixelX
    let snappedY = pixelY
    const newGuides = []

    const currentPageFields = fields.filter((f) => f.page === currentPage && f.id !== fieldId)
    for (const f of currentPageFields) {
      const fx = f.x * scaleFactor
      const fy = f.y * scaleFactor
      const fw = f.width * scaleFactor
      const fh = f.height * scaleFactor
      // Top edge to top edge
      if (Math.abs(pixelY - fy) < SNAP_THRESHOLD) {
        snappedY = fy
        newGuides.push({ type: 'horizontal', pos: fy })
      }
      if (Math.abs((pixelY + fieldHeight) - (fy + fh)) < SNAP_THRESHOLD) {
        snappedY = fy + fh - fieldHeight
        newGuides.push({ type: 'horizontal', pos: fy + fh })
      }
      if (Math.abs(pixelY - (fy + fh)) < SNAP_THRESHOLD) {
        snappedY = fy + fh
        newGuides.push({ type: 'horizontal', pos: fy + fh })
      }
      if (Math.abs(pixelX - fx) < SNAP_THRESHOLD) {
        snappedX = fx
        newGuides.push({ type: 'vertical', pos: fx })
      }
      if (Math.abs((pixelX + fieldWidth) - (fx + fw)) < SNAP_THRESHOLD) {
        snappedX = fx + fw - fieldWidth
        newGuides.push({ type: 'vertical', pos: fx + fw })
      }
      if (Math.abs(pixelX - (fx + fw)) < SNAP_THRESHOLD) {
        snappedX = fx + fw
        newGuides.push({ type: 'vertical', pos: fx + fw })
      }
    }

    setGuides(newGuides)
    return { x: snappedX, y: snappedY }
  }, [fields, currentPage])

  // -- Mouse handlers for drag/resize --

  useEffect(() => {
    const scaleFactor = scale / DESIGN_SCALE
    const handleMouseMove = (e) => {
      if (dragState.current.active) {
        const overlay = overlayRef.current
        if (!overlay) return
        const rect = overlay.getBoundingClientRect()
        const field = fields.find((f) => f.id === dragState.current.fieldId)
        if (!field) return

        let pixelX = e.clientX - rect.left - dragState.current.offsetX
        let pixelY = e.clientY - rect.top - dragState.current.offsetY
        const fieldWidthPx = field.width * scaleFactor
        const fieldHeightPx = field.height * scaleFactor

        const snapped = snapToAlignment(pixelX, pixelY, field.id, fieldWidthPx, fieldHeightPx, scaleFactor)
        pixelX = snapped.x
        pixelY = snapped.y

        const designX = (pixelX * DESIGN_SCALE) / scale
        const designY = (pixelY * DESIGN_SCALE) / scale
        const maxDesignX = (canvasSize.width * DESIGN_SCALE) / scale - field.width
        const maxDesignY = (canvasSize.height * DESIGN_SCALE) / scale - field.height
        const clampedX = Math.max(0, Math.min(designX, maxDesignX))
        const clampedY = Math.max(0, Math.min(designY, maxDesignY))

        updateField(field.id, { x: clampedX, y: clampedY })
        setPositionGuides({
          left: clampedX * scaleFactor,
          top: clampedY * scaleFactor,
          right: (clampedX + field.width) * scaleFactor,
          bottom: (clampedY + field.height) * scaleFactor,
        })
      }

      if (resizeState.current.active) {
        const field = fields.find((f) => f.id === resizeState.current.fieldId)
        if (!field) return

        const deltaX = e.clientX - resizeState.current.startX
        const deltaY = e.clientY - resizeState.current.startY
        const newDesignWidth = Math.max(100, resizeState.current.startW + deltaX / scaleFactor)
        const newDesignHeight = Math.max(30, resizeState.current.startH + deltaY / scaleFactor)
        const maxDesignWidth = (canvasSize.width * DESIGN_SCALE) / scale - field.x
        const maxDesignHeight = (canvasSize.height * DESIGN_SCALE) / scale - field.y

        updateField(field.id, {
          width: Math.min(newDesignWidth, maxDesignWidth),
          height: Math.min(newDesignHeight, maxDesignHeight),
        })
      }
    }

    const handleMouseUp = () => {
      dragState.current.active = false
      resizeState.current.active = false
      setGuides([])
      setPositionGuides(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [fields, canvasSize, snapToAlignment, updateField, scale])

  // -- Drop from components panel --

  const handleOverlayDragEnter = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleOverlayDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleOverlayDrop = (e) => {
    e.preventDefault()
    const componentType = e.dataTransfer.getData('component-type') || e.dataTransfer.getData('text/plain')
    if (!componentType) return
    const overlay = overlayRef.current
    if (!overlay) return
    const rect = overlay.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    addField(componentType, x, y, currentPage)
  }

  // -- Field mousedown for dragging --

  const handleFieldMouseDown = (e, field) => {
    if (
      e.target.classList.contains('fb-field-resize') ||
      e.target.classList.contains('fb-field-delete') ||
      e.target.closest('.fb-field-delete')
    ) return
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return

    e.preventDefault()
    const overlay = overlayRef.current
    if (!overlay) return
    const fieldEl = e.currentTarget
    const fieldRect = fieldEl.getBoundingClientRect()

    dragState.current = {
      active: true,
      fieldId: field.id,
      offsetX: e.clientX - fieldRect.left,
      offsetY: e.clientY - fieldRect.top,
    }
    setSelectedFieldId(field.id)
  }

  const handleResizeMouseDown = (e, field) => {
    e.stopPropagation()
    resizeState.current = {
      active: true,
      fieldId: field.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: field.width,
      startH: field.height,
    }
  }

  // Click overlay background to deselect
  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) {
      setSelectedFieldId(null)
    }
  }

  // -- Form Selection Modal Logic --

  const confirmSelection = () => {
    setShowSelectionModal(false)
    if (selectionMode === 'new') {
      setFields([])
    } else if (selectionMode === 'existing' && selectionFormId) {
      loadFormById(selectionFormId).then((data) => {
        if (data.success && data.form?.fields) {
          setLoadedFormName(data.form.name || null)
          setSourceFormIds(
            data.form.sourceFormIds?.length ? data.form.sourceFormIds : [selectionFormId],
          )
          setFields(data.form.fields.map((f) => ({ ...f, page: f.page || 1 })))
        }
      })
    }
  }

  // -- Save Modal Logic --

  const openSaveModal = async () => {
    setShowSaveModal(true)
    setSaveFormName(loadedFormName || '')
    setSaveFormNameNew('')
    setSaveFormNameMode(loadedFormName ? 'select' : 'select')
    setSaveDescription('')
    setSaveSelectedFormId('')
    setSaveCreateNewVersion(false)

    try {
      const data = await listForms()
      if (data.success && data.forms) {
        setAllFormsData(data.forms)
        const names = [...new Set(data.forms.map((f) => f.name))].sort()
        setAllFormNames(names)

        if (loadedFormName) {
          const match = data.forms.find(
            (f) => f.name === loadedFormName && f.pdfFile === pdfFile && f.isLatest,
          )
          if (match) {
            setSaveSelectedFormId(match.id)
          }
        }
      }
    } catch {}
  }

  const getVersionPreview = () => {
    const name = saveFormNameMode === 'new' ? saveFormNameNew : saveFormName
    if (!name?.trim()) return null
    const matching = allFormsData.filter((f) => f.name === name && f.pdfFile === pdfFile)
    if (matching.length === 0) {
      return { text: 'This will create a new form (Version 1)', type: 'new' }
    }
    const maxVersion = Math.max(...matching.map((f) => f.version || 1))
    return {
      text: `This form already exists. Next version will be: Version ${maxVersion + 1}`,
      type: 'existing',
    }
  }

  const handleConfirmSave = async () => {
    const finalName = saveFormNameMode === 'new' ? saveFormNameNew.trim() : saveFormName.trim()
    if (!finalName) { alert('Please select or enter a form name'); return }
    if (!saveUserName.trim()) { alert('Please enter your name for the audit trail'); return }

    setSaving(true)
    try {
      localStorage.setItem('ebrUserDisplayName', saveUserName.trim())
    } catch {}

    try {
      const body = {
        name: finalName,
        description: saveDescription.trim(),
        pdfFile,
        fields,
        formId: saveSelectedFormId || null,
        createNewVersion: saveCreateNewVersion && saveSelectedFormId ? true : false,
        userName: saveUserName.trim(),
        sourceFormIds: sourceFormIds.length > 0 ? sourceFormIds : undefined,
        isCombined: sourceFormIds.length > 1,
        createdAt: new Date().toISOString(),
      }
      const result = await saveForm(body)
      if (result.success) {
        alert(saveSelectedFormId ? 'Form updated successfully!' : 'Form saved successfully!')
        setLoadedFormName(finalName)
        setShowSaveModal(false)
      } else {
        alert('Error saving form: ' + (result.message || 'Unknown error'))
      }
    } catch (err) {
      alert('Error saving form: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // -- Existing stages from fields --

  const existingStages = useMemo(() => {
    const set = new Set()
    fields.forEach((f) => {
      if (f.stageInProcess?.trim()) set.add(f.stageInProcess.trim())
    })
    return [...set].sort()
  }, [fields])

  // -- Grouped forms for selection modal --

  const groupedAvailableForms = useMemo(() => {
    const grouped = {}
    availableForms.forEach((f) => {
      if (!grouped[f.name]) grouped[f.name] = []
      grouped[f.name].push(f)
    })
    Object.values(grouped).forEach((arr) => arr.sort((a, b) => (b.version || 1) - (a.version || 1)))
    return grouped
  }, [availableForms])

  // -- No file guard --

  if (!pdfFile) {
    return (
      <div className="page-content">
        <h1 className="page-title">Form Builder</h1>
        <p className="error-message">
          No template selected. Choose a template from <Link to="/templates">Templates</Link> or{' '}
          <Link to="/forms/build">Build Form</Link>.
        </p>
      </div>
    )
  }

  // Fields for the current page
  const pageFields = fields.filter((f) => f.page === currentPage)

  return (
    <div className="fb-root">
      {/* Header */}
      <div className="fb-header">
        <h1>Form Builder</h1>
        <div className="fb-header-actions">
          <button className="fb-btn fb-btn-success" onClick={openSaveModal}>
            Save Form
          </button>
          <Link to="/templates" className="fb-btn fb-btn-ghost">
            &larr; Back
          </Link>
        </div>
      </div>

      <div className="fb-main">
        {/* Components Panel - collapsible; vertical toggle on right edge */}
        <div className={`fb-components-panel ${componentsPanelCollapsed ? 'fb-components-panel-collapsed' : ''}`}>
          {!componentsPanelCollapsed && (
            <div className="fb-components-panel-content">
              <h2 className="fb-components-panel-title">Components</h2>
              {canvasSize.width > 0 && canvasSize.height > 0 && (
                <p className="fb-drag-hint">Drag onto the PDF to add a field.</p>
              )}
              {COMPONENT_TYPES.map((c) => {
                const Icon = c.Icon
                return (
                  <div
                    key={c.type}
                    className="fb-component-item"
                    draggable="true"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('component-type', c.type)
                      e.dataTransfer.setData('text/plain', c.type)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <Icon className="fb-component-icon" />
                    <span className="fb-component-name">{c.name}</span>
                  </div>
                )
              })}
            </div>
          )}
          <button
            type="button"
            className="fb-components-panel-toggle"
            onClick={() => setComponentsPanelCollapsed((c) => !c)}
            title={componentsPanelCollapsed ? 'Expand components' : 'Collapse components'}
            aria-label={componentsPanelCollapsed ? 'Expand components' : 'Collapse components'}
          >
            <span className="fb-components-panel-toggle-line">
              <span className="fb-components-panel-toggle-label">{componentsPanelCollapsed ? 'Components' : ''}</span>
              {componentsPanelCollapsed ? (
                <ChevronDoubleRightIcon className="fb-components-panel-toggle-chevron" />
              ) : (
                <ChevronDoubleLeftIcon className="fb-components-panel-toggle-chevron" />
              )}
            </span>
          </button>
        </div>

        {/* Canvas Area */}
        <div className="fb-canvas-area" onWheel={handleCanvasWheel}>
          {/* Zoom row: above ruler so it never covers it; always visible */}
          <div className="fb-zoom-row">
            <div className="fb-zoom-controls">
              <button onClick={zoomOut} title="Zoom Out">&minus;</button>
              <span>{Math.round(scale * 100)}%</span>
              <button onClick={zoomIn} title="Zoom In">+</button>
              <button onClick={resetZoom} title="Reset zoom" aria-label="Reset zoom">&#8635;</button>
            </div>
          </div>
          <div className="fb-canvas-scroll">
          <div className="fb-rulers-and-canvas">
            {/* Top ruler (sticky when scrolling down) */}
            {canvasSize.width > 0 && canvasSize.height > 0 && (
              <div className="fb-ruler-top-row">
                <div className="fb-ruler-corner" />
                <div
                  className="fb-ruler fb-ruler-top"
                  style={{ width: canvasSize.width, height: RULER_SIZE }}
                >
                  {Array.from({ length: Math.ceil(canvasSize.width / RULER_TICK_INTERVAL) + 1 }, (_, i) => {
                    const x = i * RULER_TICK_INTERVAL
                    if (x > canvasSize.width) return null
                    const isMajor = x % RULER_LABEL_INTERVAL === 0
                    return (
                      <div
                        key={x}
                        className={`fb-ruler-tick fb-ruler-tick-top ${isMajor ? 'major' : ''}`}
                        style={{ left: x }}
                      >
                        {isMajor && <span className="fb-ruler-label">{x}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="fb-ruler-body-row">
              {/* Left ruler */}
              {canvasSize.width > 0 && canvasSize.height > 0 && (
                <div
                  className="fb-ruler fb-ruler-left"
                  style={{ width: RULER_SIZE, height: canvasSize.height }}
                >
                  {Array.from({ length: Math.ceil(canvasSize.height / RULER_TICK_INTERVAL) + 1 }, (_, i) => {
                    const y = i * RULER_TICK_INTERVAL
                    if (y > canvasSize.height) return null
                    const isMajor = y % RULER_LABEL_INTERVAL === 0
                    return (
                      <div
                        key={y}
                        className={`fb-ruler-tick fb-ruler-tick-left ${isMajor ? 'major' : ''}`}
                        style={{ top: y }}
                      >
                        {isMajor && <span className="fb-ruler-label">{y}</span>}
                      </div>
                    )
                  })}
                </div>
              )}
              <PdfViewer
            ref={pdfRef}
            pdfUrl={`/uploads/${pdfFile}`}
            scale={scale}
            onPageRendered={handlePageRendered}
            hidePagination
          >
            {/* Overlay */}
            <div
              ref={overlayRef}
              className="fb-overlay"
              style={{ width: canvasSize.width, height: canvasSize.height }}
              onDragEnter={handleOverlayDragEnter}
              onDragOver={handleOverlayDragOver}
              onDrop={handleOverlayDrop}
              onClick={handleOverlayClick}
            >
              {/* Alignment guides (snap to other fields) */}
              {guides.map((g, i) =>
                g.type === 'horizontal' ? (
                  <div
                    key={`guide-${i}`}
                    className="fb-alignment-guide fb-alignment-guide-h"
                    style={{ top: g.pos, width: canvasSize.width }}
                  />
                ) : (
                  <div
                    key={`guide-${i}`}
                    className="fb-alignment-guide fb-alignment-guide-v"
                    style={{ left: g.pos, height: canvasSize.height }}
                  />
                ),
              )}

              {/* Position guidelines (dragged field edges) */}
              {positionGuides && (
                <>
                  <div
                    className="fb-position-guide fb-position-guide-h"
                    style={{ top: positionGuides.top, width: canvasSize.width }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-h"
                    style={{ top: positionGuides.bottom, width: canvasSize.width }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-v"
                    style={{ left: positionGuides.left, height: canvasSize.height }}
                  />
                  <div
                    className="fb-position-guide fb-position-guide-v"
                    style={{ left: positionGuides.right, height: canvasSize.height }}
                  />
                </>
              )}

              {/* Form fields */}
              {pageFields.map((field) => (
                <FormField
                  key={field.id}
                  field={field}
                  selected={selectedFieldId === field.id}
                  scaleFactor={scaleFactor}
                  onMouseDown={(e) => handleFieldMouseDown(e, field)}
                  onResizeMouseDown={(e) => handleResizeMouseDown(e, field)}
                  onDelete={() => deleteField(field.id)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedFieldId(field.id)
                  }}
                />
              ))}
            </div>
          </PdfViewer>
            </div>
          </div>
          </div>
          {/* Page navigation - bottom of view, icon-based */}
          {totalPages > 1 && (
            <div className="fb-page-nav">
              <button
                type="button"
                className="fb-page-nav-btn"
                onClick={goToPrevPage}
                disabled={currentPage <= 1}
                title="Previous page"
                aria-label="Previous page"
              >
                &#8249;
              </button>
              <span className="fb-page-nav-label">Page {currentPage} of {totalPages}</span>
              <button
                type="button"
                className="fb-page-nav-btn"
                onClick={goToNextPage}
                disabled={currentPage >= totalPages}
                title="Next page"
                aria-label="Next page"
              >
                &#8250;
              </button>
            </div>
          )}
        </div>

        {/* Properties Panel - only visible when a field is selected */}
        {selectedField && (
          <div className="fb-properties-panel">
            <h2>Properties</h2>
            <PropertiesForm
              field={selectedField}
              existingStages={existingStages}
              onUpdate={(updates) => updateField(selectedField.id, updates)}
            />
          </div>
        )}
      </div>

      {/* Form Selection Modal */}
      {showSelectionModal && !urlFormId && (
        <div className="fb-modal-backdrop" onClick={() => {}}>
          <div className="fb-selection-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Start Form Builder</h2>
            <p>Choose how you want to start building your form:</p>

            <div className="fb-selection-options">
              <div
                className={`fb-selection-option ${selectionMode === 'new' ? 'selected' : ''}`}
                onClick={() => {
                  setSelectionMode('new')
                  setSelectionFormId(null)
                }}
              >
                <h3>Start New Form</h3>
                <p>Create a completely new form from scratch</p>
              </div>
              {(availableForms.length > 0 || formsLoading) && (
                <div
                  className={`fb-selection-option ${selectionMode === 'existing' ? 'selected' : ''}`}
                  onClick={() => setSelectionMode('existing')}
                >
                  <h3>Load Existing Form</h3>
                  <p>Continue editing an existing form or version</p>
                </div>
              )}
            </div>

            {selectionMode === 'existing' && (
              <div className="fb-existing-forms-list">
                <h3>Select a form to load:</h3>
                {formsLoading ? (
                  <p className="fb-loading-text">Loading forms...</p>
                ) : (
                  Object.entries(groupedAvailableForms).map(([name, versions]) => (
                    <div key={name}>
                      {versions.map((form) => {
                        const isLatest =
                          form.isLatest || form.version === versions[0].version
                        return (
                          <div
                            key={form.id}
                            className={`fb-existing-form-item ${selectionFormId === form.id ? 'selected' : ''}`}
                            onClick={() => setSelectionFormId(form.id)}
                          >
                            <div className="fb-existing-form-header">
                              <span className="fb-existing-form-name">{form.name}</span>
                              <span
                                className={`fb-version-badge ${isLatest ? 'latest' : 'older'}`}
                              >
                                v{form.version || 1}
                                {isLatest ? ' - LATEST' : ''}
                              </span>
                            </div>
                            <div className="fb-existing-form-meta">
                              {form.fieldCount || 0} fields &bull; Updated:{' '}
                              {formatDate(form.updatedAt)}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="fb-selection-actions">
              <button
                className="fb-btn fb-btn-success"
                disabled={
                  !selectionMode ||
                  (selectionMode === 'existing' && !selectionFormId)
                }
                onClick={confirmSelection}
              >
                Continue
              </button>
              <Link to="/templates" className="fb-btn fb-btn-cancel">
                Cancel
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Save Modal */}
      {showSaveModal && (
        <div className="fb-modal-backdrop" onClick={() => setShowSaveModal(false)}>
          <div className="fb-save-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="fb-modal-close"
              onClick={() => setShowSaveModal(false)}
              title="Close"
            >
              &times;
            </button>
            <h3>Save Form Configuration</h3>

            <div className="fb-form-group">
              <label>Form Name:</label>
              {saveFormNameMode === 'select' ? (
                <select
                  value={saveFormName}
                  onChange={(e) => {
                    if (e.target.value === '__NEW__') {
                      setSaveFormNameMode('new')
                      setSaveFormName('')
                      setSaveSelectedFormId('')
                    } else {
                      setSaveFormName(e.target.value)
                      const match = allFormsData.find(
                        (f) => f.name === e.target.value && f.pdfFile === pdfFile && f.isLatest,
                      )
                      setSaveSelectedFormId(match?.id || '')
                    }
                  }}
                >
                  <option value="">-- Select or enter new form name --</option>
                  <option value="__NEW__">Add new form name...</option>
                  {allFormNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : (
                <div>
                  <input
                    type="text"
                    value={saveFormNameNew}
                    onChange={(e) => setSaveFormNameNew(e.target.value)}
                    placeholder="Enter new form name"
                    autoFocus
                  />
                  <button
                    className="fb-link-btn"
                    onClick={() => {
                      setSaveFormNameMode('select')
                      setSaveFormName(loadedFormName || '')
                    }}
                  >
                    Back to list
                  </button>
                </div>
              )}
              {(() => {
                const preview = getVersionPreview()
                if (!preview) return null
                return (
                  <div
                    className={`fb-version-preview ${preview.type === 'new' ? 'new' : 'existing'}`}
                  >
                    {preview.text}
                  </div>
                )
              })()}
              <small className="fb-hint">
                Select an existing form name or choose &ldquo;Add new...&rdquo; to create a new form name
              </small>
            </div>

            <div className="fb-form-group">
              <label>Description (optional):</label>
              <textarea
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                placeholder="Enter description"
              />
            </div>

            <div className="fb-form-group">
              <label>Your Name (required for audit trail):</label>
              <input
                type="text"
                value={saveUserName}
                onChange={(e) => setSaveUserName(e.target.value)}
                placeholder="Enter your name"
                required
              />
              <small className="fb-hint">
                This will be recorded in the audit trail for tracking changes
              </small>
            </div>

            {saveSelectedFormId && (
              <div className="fb-version-options">
                <h4>Save Options:</h4>
                <div className="fb-version-option">
                  <label>
                    <input
                      type="radio"
                      name="saveOption"
                      checked={!saveCreateNewVersion}
                      onChange={() => setSaveCreateNewVersion(false)}
                    />
                    Save as new version (recommended)
                  </label>
                  <div className="fb-version-option-desc">
                    Creates a new minor version with audit trail.
                  </div>
                </div>
                <div className="fb-version-option">
                  <label>
                    <input
                      type="radio"
                      name="saveOption"
                      checked={saveCreateNewVersion}
                      onChange={() => setSaveCreateNewVersion(true)}
                    />
                    Create new version explicitly
                  </label>
                  <div className="fb-version-option-desc">
                    Explicitly create a new version
                  </div>
                </div>
              </div>
            )}

            <div className="fb-modal-actions">
              <button
                className="fb-btn fb-btn-success"
                onClick={handleConfirmSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className="fb-btn fb-btn-cancel"
                onClick={() => setShowSaveModal(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// -- FormField sub-component --

function FormField({ field, selected, scaleFactor = 1, onMouseDown, onResizeMouseDown, onDelete, onClick }) {
  return (
    <div
      className={`fb-field ${selected ? 'selected' : ''}`}
      style={{
        left: field.x * scaleFactor,
        top: field.y * scaleFactor,
        width: field.width * scaleFactor,
        height: field.height * scaleFactor,
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <div className="fb-field-label">{field.label || 'Field'}</div>
      <FieldPreview field={field} />
      <div className="fb-field-resize" onMouseDown={onResizeMouseDown} />
      {selected && (
        <button
          className="fb-field-delete"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          &times;
        </button>
      )}
    </div>
  )
}

function FieldPreview({ field }) {
  const containerStyle = {
    padding: 4,
    height: 'calc(100% - 24px)',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
  }
  switch (field.type) {
    case 'text':
      return (
        <div style={containerStyle}>
          <input type="text" className="fb-field-input" placeholder={field.placeholder} disabled />
        </div>
      )
    case 'date':
      return (
        <div style={containerStyle}>
          <input type="date" className="fb-field-input" disabled />
        </div>
      )
    case 'number':
      return (
        <div style={containerStyle}>
          <div className="fb-unit-group">
            <input
              type="number"
              className="fb-field-input"
              placeholder={field.placeholder}
              disabled
              style={{ flex: 1 }}
            />
            {field.unit && <span className="fb-unit-label">{field.unit}</span>}
          </div>
        </div>
      )
    case 'signature':
      return (
        <div style={containerStyle}>
          <div className="fb-signature-placeholder">{field.placeholder || 'Sign here'}</div>
        </div>
      )
    case 'textarea':
      return (
        <div style={containerStyle}>
          <textarea
            className="fb-field-input"
            placeholder={field.placeholder}
            disabled
            style={{ resize: 'none' }}
          />
        </div>
      )
    case 'dropdown':
      return (
        <div style={containerStyle}>
          <select className="fb-field-input" disabled>
            {(field.options || []).map((opt, i) => (
              <option key={i}>{opt}</option>
            ))}
          </select>
        </div>
      )
    case 'checkbox':
      return (
        <div style={containerStyle}>
          <input type="checkbox" className="fb-field-input" disabled />
        </div>
      )
    default:
      return <div style={containerStyle} />
  }
}

// -- Properties Form sub-component --

function PropertiesForm({ field, existingStages, onUpdate }) {
  const [stageMode, setStageMode] = useState(
    field.stageInProcess && !existingStages.includes(field.stageInProcess) ? 'new' : 'select',
  )
  const [newStageValue, setNewStageValue] = useState(
    field.stageInProcess && !existingStages.includes(field.stageInProcess)
      ? field.stageInProcess
      : '',
  )

  // Reset local state when field changes
  useEffect(() => {
    const isExisting = existingStages.includes(field.stageInProcess)
    setStageMode(field.stageInProcess && !isExisting ? 'new' : 'select')
    setNewStageValue(field.stageInProcess && !isExisting ? field.stageInProcess : '')
  }, [field.id, field.stageInProcess, existingStages])

  return (
    <div className="fb-properties-form">
      <div className="fb-form-group">
        <label>Data Label (Field Name):</label>
        <input
          type="text"
          value={field.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
        />
      </div>

      <div className="fb-form-group">
        <label>Stage in Process:</label>
        {stageMode === 'select' ? (
          <select
            value={field.stageInProcess || ''}
            onChange={(e) => {
              if (e.target.value === '__NEW__') {
                setStageMode('new')
                setNewStageValue('')
              } else {
                onUpdate({ stageInProcess: e.target.value })
              }
            }}
          >
            <option value="">-- Select or enter new stage --</option>
            <option value="__NEW__">Add new stage...</option>
            {existingStages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <div>
            <input
              type="text"
              value={newStageValue}
              placeholder="Enter new stage name"
              onChange={(e) => setNewStageValue(e.target.value)}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) {
                  onUpdate({ stageInProcess: v })
                } else {
                  setStageMode('select')
                  onUpdate({ stageInProcess: '' })
                }
              }}
              autoFocus
            />
            <button
              className="fb-link-btn"
              onClick={() => {
                setStageMode('select')
                if (!newStageValue.trim()) onUpdate({ stageInProcess: '' })
              }}
            >
              Back to list
            </button>
          </div>
        )}
        <small className="fb-hint">
          Fields with the same stage name are grouped together.
        </small>
      </div>

      <div className="fb-form-group">
        <label>Stage Order:</label>
        <input
          type="number"
          value={field.stageOrder ?? ''}
          placeholder="Leave empty if not sequential"
          onChange={(e) =>
            onUpdate({ stageOrder: e.target.value === '' ? null : parseInt(e.target.value, 10) })
          }
        />
        <small className="fb-hint">
          Order number for sequential stages (1, 2, 3...).
        </small>
      </div>

      <div className="fb-form-group fb-grid-2">
        <div>
          <label>X:</label>
          <input
            type="number"
            value={Math.round(field.x)}
            onChange={(e) => onUpdate({ x: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
        <div>
          <label>Y:</label>
          <input
            type="number"
            value={Math.round(field.y)}
            onChange={(e) => onUpdate({ y: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
      </div>

      <div className="fb-form-group fb-grid-2">
        <div>
          <label>Width:</label>
          <input
            type="number"
            value={Math.round(field.width)}
            onChange={(e) => onUpdate({ width: Math.max(100, parseInt(e.target.value, 10) || 100) })}
          />
        </div>
        <div>
          <label>Height:</label>
          <input
            type="number"
            value={Math.round(field.height)}
            onChange={(e) => onUpdate({ height: Math.max(30, parseInt(e.target.value, 10) || 30) })}
          />
        </div>
      </div>

      <div className="fb-form-group">
        <label className="fb-checkbox-label">
          <input
            type="checkbox"
            checked={field.required || false}
            onChange={(e) => onUpdate({ required: e.target.checked })}
          />
          Required Field
        </label>
      </div>

      <div className="fb-form-group">
        <label>Page:</label>
        <input type="number" value={field.page || 1} disabled className="fb-disabled-input" />
        <small className="fb-hint">Field is on page {field.page || 1}</small>
      </div>

      {/* Type-specific */}
      {(field.type === 'text' || field.type === 'textarea') && (
        <div className="fb-form-group">
          <label>Placeholder:</label>
          <input
            type="text"
            value={field.placeholder || ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
          />
        </div>
      )}

      {field.type === 'number' && (
        <div className="fb-form-group">
          <label>Unit of Measurement:</label>
          <select
            value={field.unit || ''}
            onChange={(e) => onUpdate({ unit: e.target.value })}
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u || 'None'}
              </option>
            ))}
          </select>
        </div>
      )}

      {field.type === 'dropdown' && (
        <div className="fb-form-group">
          <label>Options (one per line):</label>
          <textarea
            value={(field.options || []).join('\n')}
            onChange={(e) =>
              onUpdate({ options: e.target.value.split('\n').filter((o) => o.trim()) })
            }
          />
        </div>
      )}
    </div>
  )
}
