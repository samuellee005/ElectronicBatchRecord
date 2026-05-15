const fieldPreviewContainerBase = {
  padding: '2px 2px',
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  alignItems: 'stretch',
  overflow: 'hidden',
}

export default function FieldPreview({ field, selected = false, onFieldUpdate, renderTablePreview = null }) {
  const containerStyle = fieldPreviewContainerBase
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
            className="fb-field-input fb-field-input--textarea"
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
        <div style={{ ...containerStyle, justifyContent: 'center', alignItems: 'center' }}>
          <input type="checkbox" className="fb-field-input" disabled />
        </div>
      )
    case 'time':
      return (
        <div style={{ ...containerStyle, flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
          <input type="time" className="fb-field-input" disabled style={{ flex: 1 }} />
          <button type="button" className="fb-field-now-btn" disabled>
            Now
          </button>
        </div>
      )
    case 'radio':
      return (
        <div
          style={{
            ...containerStyle,
            justifyContent: 'flex-start',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            overflowY: 'auto',
          }}
        >
          {(field.options || ['A', 'B']).slice(0, 4).map((opt, i) => (
            <label key={i} className="fb-preview-radio">
              <input type="radio" disabled /> {opt}
            </label>
          ))}
        </div>
      )
    case 'multiselect':
      return (
        <div
          style={{
            ...containerStyle,
            justifyContent: 'flex-start',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 4,
            overflowY: 'auto',
          }}
        >
          {(field.options || []).slice(0, 4).map((opt, i) => (
            <label key={i} className="fb-preview-radio">
              <input type="checkbox" disabled /> {opt}
            </label>
          ))}
        </div>
      )
    case 'collaborator':
      return (
        <div
          style={{
            ...containerStyle,
            justifyContent: 'flex-start',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 6,
            fontSize: '0.75rem',
          }}
        >
          <div className="fb-collab-preview-row">
            <span>Primary</span>
            <select className="fb-field-input" disabled>
              <option>—</option>
            </select>
          </div>
          <div className="fb-collab-preview-row">
            <span>Reviewer</span>
            <select className="fb-field-input" disabled>
              <option>—</option>
            </select>
          </div>
          <label className="fb-preview-radio">
            <input type="checkbox" disabled /> Reviewer records all entry
          </label>
        </div>
      )
    case 'table':
      if (typeof renderTablePreview === 'function') {
        return renderTablePreview({ field, selected, onFieldUpdate, containerStyle: { ...containerStyle, padding: 2 } })
      }
      return <div style={containerStyle} />
    default:
      return <div style={containerStyle} />
  }
}

