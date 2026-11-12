import { useId } from 'react';

export function CategoryField({ value, onChange, categories, label = 'Category', disabled = false }: {
  value: string; onChange: (value: string) => void; categories: string[]; label?: string; disabled?: boolean;
}) {
  const id = useId();
  return <label className="category-field">{label}<input required maxLength={40} list={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
    <datalist id={id}>{categories.map(category => <option key={category} value={category} />)}</datalist>
  </label>;
}
