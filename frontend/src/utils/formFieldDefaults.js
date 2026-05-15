/**
 * Shared defaults for form fields (Form Builder palette + PDF import).
 * Keep in sync with DEFAULT_CONFIGS in FormBuilder.jsx.
 */
export const DEFAULT_INPUT_FONT_PX = 13

export const FORM_FIELD_DEFAULTS = {
  text: { width: 200, height: 35, label: 'Text Field', placeholder: 'Enter text' },
  date: { width: 200, height: 35, label: 'Date Field', placeholder: 'Select date' },
  number: { width: 200, height: 35, label: 'Number Field', placeholder: 'Enter number', unit: '' },
  time: { width: 220, height: 42, label: 'Time', placeholder: 'HH:MM' },
  checkbox: { width: 150, height: 30, label: 'Checkbox Field' },
  signature: { width: 300, height: 100, label: 'Signature Field', placeholder: 'Sign here' },
  dropdown: { width: 200, height: 35, label: 'Dropdown Field', options: ['Option 1', 'Option 2'] },
  radio: { width: 280, height: 100, label: 'Radio Group', options: ['Option A', 'Option B', 'Option C'] },
  multiselect: { width: 280, height: 120, label: 'Multi select', options: ['Item 1', 'Item 2', 'Item 3'] },
  collaborator: {
    width: 320,
    height: 140,
    label: 'Collaborators',
    helpText: 'Designate primary analyst and secondary reviewer from Active Users.',
  },
  table: { width: 420, height: 240, label: 'Data table' },
  textarea: { width: 300, height: 100, label: 'Text Area', placeholder: 'Enter text' },
}
