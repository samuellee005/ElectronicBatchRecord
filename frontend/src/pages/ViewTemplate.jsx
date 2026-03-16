import { useSearchParams } from 'react-router-dom'
import { Link } from 'react-router-dom'

export default function ViewTemplate() {
  const [searchParams] = useSearchParams()
  const file = searchParams.get('file')
  const pdfUrl = file ? '/uploads/' + encodeURIComponent(file) : null

  if (!file) {
    return (
      <div className="page-content">
        <h1 className="page-title">View Template</h1>
        <p className="error-message">No file specified.</p>
        <Link to="/templates">Back to Templates</Link>
      </div>
    )
  }

  return (
    <div className="page-content">
      <h1 className="page-title">View Template</h1>
      <p><Link to="/templates">Back to Templates</Link></p>
      <div className="pdf-view-wrapper" style={{ marginTop: 16, background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
        <iframe title="PDF template" src={pdfUrl} style={{ width: '100%', height: '80vh', border: 'none' }} />
      </div>
    </div>
  )
}
