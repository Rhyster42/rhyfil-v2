import { Sheet } from '../ui/Sheet';

export const LINE_VOID_REASONS = ['Rang in error', 'Customer changed mind', 'Made wrong'];
export const ORDER_VOID_REASONS = ['Rang in error', 'Customer left', 'Customer changed mind', 'Test order'];
export const REVERSAL_REASONS = ['Wrong tender', 'Split fell through', 'Card declined', 'Customer changed mind'];

interface ReasonSheetProps {
  title: string;
  detail?: string;
  reasons: string[];
  danger?: boolean;
  onChoose: (reason: string) => void;
  onClose: () => void;
}

/** One tap to say why (voids and reversals are reported per person). */
export function ReasonSheet({ title, detail, reasons, danger, onChoose, onClose }: ReasonSheetProps) {
  return (
    <Sheet title={title} onClose={onClose}>
      {detail && <p className="muted">{detail}</p>}
      <div className="reason-list">
        {reasons.map((r) => (
          <button key={r} type="button" className={`btn btn-block ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onChoose(r)}>
            {r}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
