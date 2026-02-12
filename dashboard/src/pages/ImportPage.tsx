import { useState, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Upload,
  FileSpreadsheet,
  Download,
  Check,
  X,
  AlertCircle,
  Loader2,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Smartphone,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface Circle {
  id: string;
  name: string;
}

interface ParsedRow {
  name: string;
  phone: string;
  email: string;
  notes: string;
  rawRow: Record<string, string>;
  isValid: boolean;
  error?: string;
}

interface ImportResult {
  status: 'success' | 'skipped' | 'error';
  name: string;
  error?: string;
}

type ViewState = 'upload' | 'preview' | 'importing' | 'complete';

// ===========================================================================
// CSV Template
// ===========================================================================

const CSV_TEMPLATE = `name,phone,email,notes
John Smith,+15551234567,john@example.com,Met at conference
Jane Doe,+15559876543,jane@example.com,College friend
Bob Wilson,,bob@company.com,Work colleague`;

const ACCEPTED_FILE_TYPES = '.csv,.vcf,.vcard';

// ===========================================================================
// Component
// ===========================================================================

export function ImportPage() {
  const navigate = useNavigate();
  const [viewState, setViewState] = useState<ViewState>('upload');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string>('');
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileType, setFileType] = useState<'csv' | 'vcf' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: circles } = useApi<Circle[]>('/api/circles');
  const { execute: createContact } = useLazyApi();
  const { execute: triggerAnalysis } = useLazyApi();

  const handleDownloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bethany-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSV = useCallback((text: string): ParsedRow[] => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('CSV must have a header row and at least one data row');
    }

    const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    
    const hasName = header.includes('name');
    if (!hasName) {
      throw new Error('CSV must have a "name" column');
    }

    const nameIdx = header.indexOf('name');
    const phoneIdx = header.indexOf('phone');
    const emailIdx = header.indexOf('email');
    const notesIdx = header.indexOf('notes');

    const rows: ParsedRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = parseCSVLine(line);
      
      const rawRow: Record<string, string> = {};
      header.forEach((h, idx) => {
        rawRow[h] = values[idx] || '';
      });

      const name = (values[nameIdx] || '').trim();
      const phone = phoneIdx >= 0 ? (values[phoneIdx] || '').trim() : '';
      const email = emailIdx >= 0 ? (values[emailIdx] || '').trim() : '';
      const notes = notesIdx >= 0 ? (values[notesIdx] || '').trim() : '';

      let isValid = true;
      let error: string | undefined;

      if (!name) {
        isValid = false;
        error = 'Name is required';
      } else if (email && !isValidEmail(email)) {
        isValid = false;
        error = 'Invalid email format';
      } else if (phone && !isValidPhone(phone)) {
        isValid = false;
        error = 'Invalid phone format';
      }

      rows.push({ name, phone, email, notes, rawRow, isValid, error });
    }

    return rows;
  }, []);

  const parseVCard = useCallback((text: string): ParsedRow[] => {
    const rows: ParsedRow[] = [];
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed.toUpperCase().startsWith('BEGIN:VCARD')) continue;

      const lines = trimmed.split(/\r?\n/);

      let name = '';
      let phone = '';
      let email = '';
      let notes = '';
      let structuredName = '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.toUpperCase() === 'BEGIN:VCARD' || line.toUpperCase() === 'END:VCARD') continue;
        if (line.toUpperCase().startsWith('VERSION:')) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const propertyPart = line.substring(0, colonIdx);
        let value = line.substring(colonIdx + 1).trim();

        const semiIdx = propertyPart.indexOf(';');
        const propName = (semiIdx >= 0 ? propertyPart.substring(0, semiIdx) : propertyPart).toUpperCase();
        const params = semiIdx >= 0 ? propertyPart.substring(semiIdx + 1).toUpperCase() : '';

        if (params.includes('ENCODING=QUOTED-PRINTABLE')) {
          value = decodeQuotedPrintable(value);
        }

        value = value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

        switch (propName) {
          case 'FN':
            name = value.trim();
            break;
          case 'N': {
            const parts = value.split(';');
            const lastName = (parts[0] || '').trim();
            const firstName = (parts[1] || '').trim();
            const middleName = (parts[2] || '').trim();
            structuredName = [firstName, middleName, lastName].filter(Boolean).join(' ');
            break;
          }
          case 'TEL':
            if (!phone || params.includes('CELL') || params.includes('MOBILE') || params.includes('IPHONE')) {
              phone = value.trim();
            }
            break;
          case 'EMAIL':
            if (!email) {
              email = value.trim();
            }
            break;
          case 'NOTE':
            notes = value.trim();
            break;
        }
      }

      if (!name && structuredName) {
        name = structuredName;
      }

      let isValid = true;
      let error: string | undefined;

      if (!name) {
        isValid = false;
        error = 'No name found in vCard';
      } else if (email && !isValidEmail(email)) {
        isValid = false;
        error = 'Invalid email format';
      }

      const rawRow: Record<string, string> = { name, phone, email, notes };
      rows.push({ name: name || '(unnamed)', phone, email, notes, rawRow, isValid, error });
    }

    if (rows.length === 0) {
      throw new Error('No vCard entries found. Make sure the file contains BEGIN:VCARD blocks.');
    }

    return rows;
  }, []);

  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setFileType(null);

    const fileName = file.name.toLowerCase();
    const isVcf = fileName.endsWith('.vcf') || fileName.endsWith('.vcard');
    const isCsv = fileName.endsWith('.csv');

    if (!isVcf && !isCsv) {
      setParseError('Please upload a CSV or vCard (.vcf) file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const looksLikeVCard = text.trim().startsWith('BEGIN:VCARD');

        let rows: ParsedRow[];
        if (isVcf || looksLikeVCard) {
          rows = parseVCard(text);
          setFileType('vcf');
        } else {
          rows = parseCSV(text);
          setFileType('csv');
        }
        
        if (rows.length === 0) {
          setParseError('No valid contacts found in file');
          return;
        }

        setParsedRows(rows);
        setViewState('preview');
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'Failed to parse file');
      }
    };
    reader.onerror = () => {
      setParseError('Failed to read file');
    };
    reader.readAsText(file);
  }, [parseCSV, parseVCard]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleRemoveRow = useCallback((index: number) => {
    setParsedRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleImport = useCallback(async () => {
    const validRows = parsedRows.filter((r) => r.isValid);
    if (validRows.length === 0) return;

    setViewState('importing');
    setImportProgress(0);
    const results: ImportResult[] = [];

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      
      try {
        await createContact('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: row.name,
            phone: row.phone || undefined,
            email: row.email || undefined,
            notes: row.notes || undefined,
            circle_ids: selectedCircleId ? [selectedCircleId] : undefined,
            source: 'import',
          }),
        });

        results.push({ status: 'success', name: row.name });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        
        if (errorMsg.includes('duplicate') || errorMsg.includes('already exists')) {
          results.push({ status: 'skipped', name: row.name, error: 'Already exists' });
        } else {
          results.push({ status: 'error', name: row.name, error: errorMsg });
        }
      }

      setImportProgress(Math.round(((i + 1) / validRows.length) * 100));
    }

    // Trigger analysis for newly imported contacts
    try {
      await triggerAnalysis('/api/review/analyze', { method: 'POST' });
    } catch (err) {
      console.error('Failed to trigger analysis:', err);
    }

    setImportResults(results);
    setViewState('complete');
  }, [parsedRows, selectedCircleId, createContact, triggerAnalysis]);

  const handleReset = useCallback(() => {
    setViewState('upload');
    setParsedRows([]);
    setImportResults([]);
    setImportProgress(0);
    setParseError(null);
    setSelectedCircleId('');
    setFileType(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const validCount = parsedRows.filter((r) => r.isValid).length;
  const invalidCount = parsedRows.filter((r) => !r.isValid).length;
  const successCount = importResults.filter((r) => r.status === 'success').length;
  const skippedCount = importResults.filter((r) => r.status === 'skipped').length;
  const errorCount = importResults.filter((r) => r.status === 'error').length;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-medium text-charcoal mb-2">Import Contacts</h1>
        <p className="text-charcoal-light">
          Upload a CSV or vCard (.vcf) file to import your contacts in bulk.
        </p>
      </div>

      {/* Upload View */}
      {viewState === 'upload' && (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`bg-warm-white rounded-2xl border-2 border-dashed p-12 text-center transition-colors shadow-soft ${
              isDragging
                ? 'border-bethany-500 bg-bethany-50'
                : 'border-charcoal-300 hover:border-charcoal-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileInputChange}
              className="hidden"
            />
            
            <div className="w-16 h-16 bg-cream-dark rounded-full flex items-center justify-center mx-auto mb-4">
              <Upload className="w-8 h-8 text-charcoal-400" />
            </div>
            
            <h2 className="text-lg font-medium text-charcoal mb-2">
              Drop your file here
            </h2>
            <p className="text-charcoal-light mb-4">
              Supports CSV and vCard (.vcf) files
            </p>
            
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn-primary"
            >
              Choose File
            </button>

            {parseError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
                <AlertCircle className="w-4 h-4 inline mr-2" />
                {parseError}
              </div>
            )}
          </div>

          {/* iPhone vCard tip */}
          <div className="bg-blue-50 rounded-2xl p-6 border border-blue-100">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-warm-white rounded-xl flex items-center justify-center flex-shrink-0 shadow-soft">
                <Smartphone className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-charcoal mb-1">Importing from iPhone?</h3>
                <p className="text-sm text-charcoal-light">
                  Open Contacts, select the contacts you want, tap Share, then choose "Export vCard".
                  Upload the .vcf file here and Bethany will handle the rest.
                </p>
              </div>
            </div>
          </div>

          {/* Template download */}
          <div className="bg-cream rounded-2xl p-6 border border-cream-dark">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-warm-white rounded-xl flex items-center justify-center flex-shrink-0 shadow-soft">
                <FileSpreadsheet className="w-5 h-5 text-charcoal-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-charcoal mb-1">Prefer a spreadsheet?</h3>
                <p className="text-sm text-charcoal-light mb-3">
                  Download our CSV template with the correct columns: name, phone, email, and notes.
                </p>
                <button
                  onClick={handleDownloadTemplate}
                  className="inline-flex items-center gap-2 text-sm text-bethany-600 hover:text-bethany-700 font-medium"
                >
                  <Download className="w-4 h-4" />
                  Download CSV template
                </button>
              </div>
            </div>
          </div>

          {/* Format requirements */}
          <div className="card">
            <h3 className="font-medium text-charcoal mb-3">Supported formats</h3>
            <ul className="text-sm text-charcoal-light space-y-2">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-sage-500 mt-0.5 flex-shrink-0" />
                <span><strong className="text-charcoal">vCard (.vcf)</strong> — Exported from iPhone, Android, Google Contacts, or Outlook</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-sage-500 mt-0.5 flex-shrink-0" />
                <span><strong className="text-charcoal">CSV</strong> — Spreadsheet with <strong>name</strong> column (required), plus optional phone, email, notes</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-sage-500 mt-0.5 flex-shrink-0" />
                <span>Multi-contact files are supported (batch import)</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-sage-500 mt-0.5 flex-shrink-0" />
                <span>Phone numbers should include country code (e.g., +1 for US)</span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Preview View */}
      {viewState === 'preview' && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="card flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-sm text-charcoal-light">
                <strong className="text-charcoal">{parsedRows.length}</strong> contact{parsedRows.length !== 1 ? 's' : ''} found
                {fileType && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-cream-dark text-charcoal-light">
                    {fileType === 'vcf' ? 'vCard' : 'CSV'}
                  </span>
                )}
              </span>
              {invalidCount > 0 && (
                <span className="text-sm text-golden-600">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  {invalidCount} with errors
                </span>
              )}
            </div>
            <button
              onClick={handleReset}
              className="text-sm text-charcoal-light hover:text-charcoal"
            >
              Start over
            </button>
          </div>

          {/* Circle selector */}
          <div className="card">
            <label className="block text-sm font-medium text-charcoal mb-2">
              Add all contacts to a circle (optional)
            </label>
            <div className="relative">
              <select
                value={selectedCircleId}
                onChange={(e) => setSelectedCircleId(e.target.value)}
                className="input-field !w-full md:!w-64"
              >
                <option value="">No circle</option>
                {circles?.map((circle) => (
                  <option key={circle.id} value={circle.id}>
                    {circle.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Preview table */}
          <div className="card !p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-cream border-b border-cream-dark">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-charcoal-light">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-charcoal-light">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-charcoal-light">Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-charcoal-light">Email</th>
                    <th className="px-4 py-3 text-left font-medium text-charcoal-light">Notes</th>
                    <th className="px-4 py-3 text-right font-medium text-charcoal-light"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-dark">
                  {parsedRows.slice(0, 50).map((row, index) => (
                    <tr key={index} className={row.isValid ? '' : 'bg-red-50'}>
                      <td className="px-4 py-3">
                        {row.isValid ? (
                          <CheckCircle2 className="w-4 h-4 text-sage-500" />
                        ) : (
                          <span className="flex items-center gap-1 text-red-600">
                            <XCircle className="w-4 h-4" />
                            <span className="text-xs">{row.error}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-charcoal">{row.name || '\u2014'}</td>
                      <td className="px-4 py-3 text-charcoal-light">{row.phone || '\u2014'}</td>
                      <td className="px-4 py-3 text-charcoal-light">{row.email || '\u2014'}</td>
                      <td className="px-4 py-3 text-charcoal-light max-w-xs truncate">{row.notes || '\u2014'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRemoveRow(index)}
                          className="p-1 text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-dark rounded-xl"
                          title="Remove row"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {parsedRows.length > 50 && (
              <div className="px-4 py-3 bg-cream border-t border-cream-dark text-sm text-charcoal-light text-center">
                Showing first 50 of {parsedRows.length} contacts
              </div>
            )}
          </div>

          {/* Import button */}
          <div className="card flex items-center justify-between">
            <div>
              <p className="font-medium text-charcoal">
                Import {validCount} contact{validCount !== 1 ? 's' : ''}?
              </p>
              {invalidCount > 0 && (
                <p className="text-sm text-charcoal-light">
                  {invalidCount} contact{invalidCount !== 1 ? 's' : ''} with errors will be skipped
                </p>
              )}
            </div>
            <button
              onClick={handleImport}
              disabled={validCount === 0}
              className="btn-primary"
            >
              <Upload className="w-4 h-4" />
              Import
            </button>
          </div>
        </div>
      )}

      {/* Importing View */}
      {viewState === 'importing' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Importing contacts...</h2>
          <p className="text-charcoal-light mb-6">
            Please don't close this page
          </p>
          
          {/* Progress bar */}
          <div className="max-w-xs mx-auto">
            <div className="h-2 bg-cream-dark rounded-full overflow-hidden">
              <div
                className="h-full bg-bethany-500 transition-all duration-300"
                style={{ width: `${importProgress}%` }}
              />
            </div>
            <p className="text-sm text-charcoal-light mt-2">{importProgress}%</p>
          </div>
        </div>
      )}

      {/* Complete View */}
      {viewState === 'complete' && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="card text-center">
            <div className="w-16 h-16 bg-sage-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-sage-500" />
            </div>
            <h2 className="text-lg font-medium text-charcoal mb-4">Import complete!</h2>
            
            <div className="flex items-center justify-center gap-6 mb-6">
              <div className="text-center">
                <p className="text-2xl font-semibold text-sage-600">{successCount}</p>
                <p className="text-sm text-charcoal-light">Imported</p>
              </div>
              {skippedCount > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-golden-500">{skippedCount}</p>
                  <p className="text-sm text-charcoal-light">Skipped</p>
                </div>
              )}
              {errorCount > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-red-600">{errorCount}</p>
                  <p className="text-sm text-charcoal-light">Failed</p>
                </div>
              )}
            </div>

            {/* Review prompt - show if contacts were imported */}
            {successCount > 0 && (
              <div className="bg-gradient-to-r from-terracotta/10 via-blush/30 to-terracotta/10 rounded-xl border border-terracotta/20 p-4 mb-6 text-left">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-warm-white rounded-lg flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-5 h-5 text-terracotta" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-medium text-charcoal mb-1">Ready to organize?</h3>
                    <p className="text-sm text-charcoal-light">
                      I've analyzed your new contacts and have some suggestions for sorting them.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              {successCount > 0 ? (
                <>
                  <Link
                    to="/review"
                    className="btn-primary"
                  >
                    <Sparkles className="w-4 h-4" />
                    Review contacts
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                  <button
                    onClick={handleReset}
                    className="btn-secondary"
                  >
                    Import More
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleReset}
                    className="btn-primary"
                  >
                    Import More
                  </button>
                  <Link
                    to="/contacts"
                    className="btn-secondary"
                  >
                    View Contacts
                  </Link>
                </>
              )}
            </div>
          </div>

          {/* Results detail */}
          {(skippedCount > 0 || errorCount > 0) && (
            <div className="card !p-0 overflow-hidden">
              <div className="px-4 py-3 bg-cream border-b border-cream-dark">
                <h3 className="font-medium text-charcoal">Import details</h3>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-cream-dark">
                    {importResults.map((result, index) => (
                      <tr key={index}>
                        <td className="px-4 py-2">
                          {result.status === 'success' && (
                            <CheckCircle2 className="w-4 h-4 text-sage-500" />
                          )}
                          {result.status === 'skipped' && (
                            <AlertTriangle className="w-4 h-4 text-golden-500" />
                          )}
                          {result.status === 'error' && (
                            <XCircle className="w-4 h-4 text-red-500" />
                          )}
                        </td>
                        <td className="px-4 py-2 font-medium text-charcoal">{result.name}</td>
                        <td className="px-4 py-2 text-charcoal-light">
                          {result.status === 'success' && 'Imported'}
                          {result.status === 'skipped' && result.error}
                          {result.status === 'error' && result.error}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  values.push(current.trim());
  return values;
}

function decodeQuotedPrintable(input: string): string {
  let result = input.replace(/=\r?\n/g, '');
  result = result.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return result;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned);
}
