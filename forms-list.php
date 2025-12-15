<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Saved Forms - Electronic Batch Record</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2rem;
            margin-bottom: 10px;
        }

        .header-actions {
            margin-top: 20px;
        }

        .content {
            padding: 40px;
        }

        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-block;
            margin: 5px;
        }

        .btn-primary {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .btn-primary:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .forms-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .form-card {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 20px;
            background: white;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .form-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }

        .form-card h3 {
            color: #333;
            margin-bottom: 10px;
        }

        .form-card p {
            color: #666;
            font-size: 0.9rem;
            margin: 5px 0;
        }

        .form-actions {
            margin-top: 15px;
            display: flex;
            gap: 10px;
        }

        .form-actions .btn {
            flex: 1;
            text-align: center;
            padding: 8px 16px;
            font-size: 0.85rem;
        }

        .btn-success {
            background: #28a745;
            color: white;
        }

        .btn-success:hover {
            background: #218838;
        }

        .btn-info {
            background: #17a2b8;
            color: white;
        }

        .btn-info:hover {
            background: #138496;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #999;
        }

        .empty-state p {
            margin-top: 10px;
            font-size: 1.1rem;
        }

        .form-group-card {
            border: 2px solid #667eea;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 25px;
            background: #f8f9ff;
        }

        .form-group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 2px solid #e0e0ff;
        }

        .form-group-title {
            font-size: 1.3rem;
            color: #333;
            font-weight: 600;
        }

        .form-group-meta {
            font-size: 0.9rem;
            color: #666;
            margin-top: 5px;
        }

        .version-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
            margin-left: 10px;
        }

        .version-badge.latest {
            background: #28a745;
            color: white;
        }

        .version-badge.older {
            background: #6c757d;
            color: white;
        }

        .versions-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }

        .version-card {
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 15px;
            background: white;
            transition: all 0.2s ease;
        }

        .version-card.latest {
            border-color: #28a745;
            border-width: 2px;
            box-shadow: 0 2px 8px rgba(40, 167, 69, 0.2);
        }

        .version-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .version-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .version-number {
            font-weight: 600;
            color: #333;
        }

        .version-info {
            font-size: 0.85rem;
            color: #666;
            margin: 5px 0;
        }

        .recommended-tag {
            background: #ffc107;
            color: #333;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.75rem;
            font-weight: 600;
            margin-left: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📋 Saved Forms</h1>
            <div class="header-actions">
                <a href="index.php" class="btn btn-primary">← Back to Templates</a>
            </div>
        </div>

        <div class="content">
            <div id="formsContainer">
                <div class="empty-state">
                    <p>Loading forms...</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Load and display forms grouped by version
        fetch('includes/list-forms.php')
            .then(response => response.json())
            .then(data => {
                const container = document.getElementById('formsContainer');

                if (!data.success || (!data.forms || data.forms.length === 0)) {
                    container.innerHTML = `
                        <div class="empty-state">
                            <h2>No forms found</h2>
                            <p>Create your first form by selecting a PDF template and clicking "Build Form"</p>
                            <a href="index.php" class="btn btn-primary" style="margin-top: 20px;">Go to Templates</a>
                        </div>
                    `;
                    return;
                }

                // Use grouped forms if available, otherwise group manually
                let groupedForms = data.groupedForms;
                if (!groupedForms) {
                    // Fallback: group manually
                    groupedForms = {};
                    data.forms.forEach(form => {
                        const key = form.name + '|' + form.pdfFile;
                        if (!groupedForms[key]) {
                            groupedForms[key] = [];
                        }
                        groupedForms[key].push(form);
                    });
                }

                let html = '';
                Object.keys(groupedForms).forEach(groupKey => {
                    const forms = groupedForms[groupKey];
                    const firstForm = forms[0];
                    const latestForm = forms.find(f => f.isLatest) || forms[0];
                    const versionCount = forms.length;

                    html += `
                        <div class="form-group-card">
                            <div class="form-group-header">
                                <div>
                                    <div class="form-group-title">
                                        ${escapeHtml(firstForm.name)}
                                        ${versionCount > 1 ? `<span class="version-badge latest">${versionCount} Versions</span>` : ''}
                                    </div>
                                    <div class="form-group-meta">
                                        PDF: ${escapeHtml(firstForm.pdfFile)} • ${firstForm.fieldCount} fields
                                        ${firstForm.description ? `<br>${escapeHtml(firstForm.description)}` : ''}
                                    </div>
                                </div>
                            </div>
                            <div class="versions-list">
                    `;

                    forms.forEach(form => {
                        const isLatest = form.isLatest || form.version === latestForm.version;
                        html += `
                            <div class="version-card ${isLatest ? 'latest' : ''}">
                                <div class="version-header">
                                    <span class="version-number">
                                        Version ${form.version || 1}
                                        ${isLatest ? '<span class="recommended-tag">LATEST</span>' : ''}
                                    </span>
                                </div>
                                <div class="version-info">
                                    <p><strong>Fields:</strong> ${form.fieldCount}</p>
                                    <p><strong>Created:</strong> ${formatDate(form.createdAt)}</p>
                                    <p><strong>Updated:</strong> ${formatDate(form.updatedAt)}</p>
                                </div>
                                <div class="form-actions" style="margin-top: 10px;">
                                    <a href="data-entry.php?form=${encodeURIComponent(form.id)}" class="btn btn-success" style="flex: 1;">
                                        📝 Use This Version
                                    </a>
                                </div>
                            </div>
                        `;
                    });

                    html += `
                            </div>
                        </div>
                    `;
                });

                container.innerHTML = html;
            })
            .catch(error => {
                console.error('Error loading forms:', error);
                document.getElementById('formsContainer').innerHTML = `
                    <div class="empty-state">
                        <p>Error loading forms. Please try again.</p>
                    </div>
                `;
            });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatDate(dateString) {
            if (!dateString) return 'Unknown';
            const date = new Date(dateString);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        }
    </script>
</body>
</html>
