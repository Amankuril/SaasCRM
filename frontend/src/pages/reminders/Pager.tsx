import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui';

export function Pager({ page, pages, total, noun, onChange }: { page: number; pages: number; total: number; noun: string; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-2 text-sm text-slate-500">
      <span className="tabular-nums">
        {total.toLocaleString('en-IN')} {noun}
        {total === 1 ? '' : 's'}
      </span>
      {pages > 1 && (
        <span className="flex items-center gap-1">
          <Button variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="tabular-nums">
            {page} of {pages}
          </span>
          <Button variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onChange(page + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </span>
      )}
    </div>
  );
}
