import { useEffect, useState } from 'react'
import { Reorder, useDragControls } from 'framer-motion'
import { GripVertical, Pause, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api, type Job } from '../api/client'
import { useQueue } from '../hooks/useQueue'
import { QueueItem } from '../components/QueueItem'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { StaggeredList, StaggeredItem } from '../components/StaggeredList'

function QueuedRow({ job, isFirst, onMoveTop, onDragEnd }: {
  job: Job
  isFirst: boolean
  onMoveTop: () => void
  onDragEnd: () => void
}) {
  const { t } = useTranslation()
  const controls = useDragControls()
  return (
    <Reorder.Item value={job.id} dragListener={false} dragControls={controls} onDragEnd={onDragEnd}>
      <QueueItem
        job={job}
        onMoveTop={isFirst ? undefined : onMoveTop}
        dragHandle={
          <button
            type="button"
            aria-label={t('queueItem.dragToReorder')}
            onPointerDown={(e) => controls.start(e)}
            className="shrink-0 h-10 w-6 flex items-center justify-center text-white/35 hover:text-white/70 cursor-grab active:cursor-grabbing touch-none"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        }
      />
    </Reorder.Item>
  )
}

export function QueuePage() {
  const { t } = useTranslation()
  const { active, recent, paused } = useQueue()
  const running = active.filter((j) => j.status === 'running')
  const queued = active.filter((j) => j.status === 'queued')
  const byId = new Map(queued.map((j) => [j.id, j]))

  // Local order while dragging; snaps back to the server order otherwise.
  const serverOrder = queued.map((j) => j.id).join('\n')
  const [order, setOrder] = useState<string[]>(queued.map((j) => j.id))
  useEffect(() => {
    setOrder(serverOrder ? serverOrder.split('\n') : [])
  }, [serverOrder])

  const commit = (ids: string[]) => {
    setOrder(ids)
    api.reorderQueue(ids).catch(() => setOrder(serverOrder ? serverOrder.split('\n') : []))
  }

  const togglePause = () => {
    ;(paused ? api.resumeQueue() : api.pauseQueue()).catch(() => {})
  }

  return (
    <div className="mx-auto w-full max-w-4xl pt-4 md:pt-6 space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50">
            {t('queue.activeCount', { count: active.length })}
          </h2>
          <Button variant="ghost" onClick={togglePause}>
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {paused ? t('queue.resume') : t('queue.pause')}
          </Button>
        </div>
        {paused && (
          <Card className="mb-2 p-4 text-sm text-amber-200/90">{t('queue.pausedNotice')}</Card>
        )}
        {active.length === 0 ? (
          <Card className="p-6 text-sm text-white/55">{t('queue.nothingActive')}</Card>
        ) : (
          <div className="flex flex-col gap-2">
            {running.map((j) => (
              <QueueItem key={j.id} job={j} />
            ))}
            <Reorder.Group axis="y" values={order} onReorder={setOrder} className="flex flex-col gap-2">
              {order
                .filter((id) => byId.has(id))
                .map((id, i) => (
                  <QueuedRow
                    key={id}
                    job={byId.get(id)!}
                    isFirst={i === 0}
                    onMoveTop={() => commit([id, ...order.filter((x) => x !== id)])}
                    onDragEnd={() => commit(order)}
                  />
                ))}
            </Reorder.Group>
          </div>
        )}
      </section>
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50 mb-3">
          {t('queue.historyCount', { count: recent.length })}
        </h2>
        {recent.length === 0 ? (
          <Card className="p-6 text-sm text-white/55">
            {t('queue.noCompletedDownloads')}
          </Card>
        ) : (
          <StaggeredList className="flex flex-col gap-2">
            {recent.slice(0, 50).map((j) => (
              <StaggeredItem key={j.id}>
                <QueueItem job={j} />
              </StaggeredItem>
            ))}
          </StaggeredList>
        )}
      </section>
    </div>
  )
}
