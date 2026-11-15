import type { CloudHostOutput } from '@humanlayer/riptide-api-contract/api/hosts/cloud'
import { Button } from '@humanlayer/ui/components/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@humanlayer/ui/components/dialog'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { AlertTriangle, Cloud, Loader2, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'

import {
	useCloudHostLogs,
	useCloudHostProgress,
	useCloudHostProviders,
	useCloudHosts,
	useCreateCloudHost,
	useDestroyCloudHost,
} from '@/hooks/use-cloud-hosts'
import {
	CLOUD_HOST_PROVIDER_LABELS,
	CLOUD_HOST_STATUS_LABELS,
	canReadCloudHostLogs,
	describeCloudHostError,
	describeCloudHostExpiry,
	isCloudHostSettling,
	isCloudHostStarting,
} from '@/lib/cloud-host-status'

import { NewCloudHostDialog, type NewCloudHostInput } from './NewCloudHostDialog'

/**
 * Cloud hosts in host settings: the "New cloud host" flow, each host's progress while it starts,
 * its logs, and deletion. A ready cloud host also shows up in the regular host list above, from
 * its daemon's heartbeat, and is picked for sessions like any other host.
 *
 * The dialog's open state lives in the URL (`?newCloudHost=true`), so the launcher's host picker
 * can open it directly.
 */
export function CloudHostsSection() {
	const search = useSearch({ strict: false }) as { newCloudHost?: true }
	const navigate = useNavigate()
	const dialogOpen = search.newCloudHost === true
	const setDialogOpen = (open: boolean) =>
		void navigate({
			to: '/settings/daemons',
			search: (previous: Record<string, unknown>) => {
				const { newCloudHost: _dropped, ...rest } = previous
				return open ? { ...rest, newCloudHost: true } : rest
			},
			replace: !open,
		})

	const hosts = useCloudHosts()
	const providers = useCloudHostProviders(dialogOpen)
	const createHost = useCreateCloudHost()
	const [deleteTarget, setDeleteTarget] = useState<CloudHostOutput | null>(null)
	const destroyHost = useDestroyCloudHost()

	const create = (input: NewCloudHostInput) => {
		createHost.mutate(input, {
			onSuccess: () => {
				setDialogOpen(false)
				toast.success('Cloud host created', {
					description: 'It appears in your host list once its daemon is online.',
				})
			},
			onError: (error) =>
				toast.error('Could not create cloud host', {
					description: describeCloudHostError(error, 'No host was started. Try again in a minute.'),
				}),
		})
	}

	const confirmDelete = () => {
		if (!deleteTarget) return
		destroyHost.mutate(
			{ hostId: deleteTarget.hostId },
			{
				onSuccess: () => {
					setDeleteTarget(null)
					toast.success('Cloud host deleted')
				},
				onError: (error) =>
					toast.error('Could not delete cloud host', {
						description: describeCloudHostError(error, 'It is still running. Try again in a moment.'),
					}),
			},
		)
	}

	const rows = hosts.data?.hosts ?? []

	return (
		<section>
			<h3 className="text-sm font-semibold mb-2 text-muted-foreground">Cloud hosts</h3>
			<p className="text-sm text-muted-foreground mb-3">
				Start a host in the cloud to run sessions without keeping this device on. Each host is deleted when its
				time limit ends.
			</p>
			<CloudHostList status={listStatus(hosts, rows.length)}>
				{rows.map((host) => (
					<WiredCloudHostRow key={host.hostId} host={host} onDelete={() => setDeleteTarget(host)} />
				))}
			</CloudHostList>
			<Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
				<Cloud className="size-3.5" />
				New cloud host
			</Button>

			<NewCloudHostDialog
				open={dialogOpen}
				providers={providers.data?.providers ?? (providers.isError ? [] : null)}
				isCreating={createHost.isPending}
				onOpenChange={setDialogOpen}
				onCreate={create}
			/>
			<CloudHostDeleteDialog
				open={deleteTarget !== null}
				isPending={destroyHost.isPending}
				onOpenChange={(open) => {
					if (!open && !destroyHost.isPending) setDeleteTarget(null)
				}}
				onConfirm={confirmDelete}
			/>
		</section>
	)
}

type CloudHostListStatus = 'loading' | 'error' | 'empty' | 'hosts'

function listStatus(query: { isPending: boolean; isError: boolean }, count: number): CloudHostListStatus {
	if (query.isError) return 'error'
	if (query.isPending) return 'loading'
	return count === 0 ? 'empty' : 'hosts'
}

function CloudHostList({ status, children }: { status: CloudHostListStatus; children: ReactNode }) {
	switch (status) {
		case 'loading':
			return null
		case 'error':
			return (
				<p className="text-sm text-muted-foreground mb-3">
					Could not load cloud hosts. Reload the page to retry.
				</p>
			)
		case 'empty':
			return <p className="text-sm text-muted-foreground mb-3">No cloud hosts</p>
		default:
			return <div className="space-y-2 mb-3">{children}</div>
	}
}

/** One cloud host. Polls its progress while it starts; shows its logs on request or after a failure. */
function WiredCloudHostRow({ host: listed, onDelete }: { host: CloudHostOutput; onDelete: () => void }) {
	const progress = useCloudHostProgress(listed.hostId, isCloudHostStarting(listed.status))
	// The progress query is fresher while the host starts; the list wins once it reports a later state.
	const host = progress.data && isCloudHostStarting(listed.status) ? { ...listed, ...progress.data.host } : listed
	const [logsOpen, setLogsOpen] = useState<boolean | null>(null)
	const showLogs = canReadCloudHostLogs(host.status) && (logsOpen ?? host.status === 'failed')

	return (
		<CloudHostRow
			host={host}
			now={Date.now()}
			logsOpen={showLogs}
			onToggleLogs={() => setLogsOpen(!showLogs)}
			onDelete={onDelete}
		>
			{showLogs && <WiredCloudHostLogs hostId={host.hostId} />}
		</CloudHostRow>
	)
}

export function CloudHostRow({
	host,
	now,
	logsOpen,
	onToggleLogs,
	onDelete,
	children,
}: {
	host: CloudHostOutput
	now: number
	logsOpen: boolean
	onToggleLogs: () => void
	onDelete: () => void
	children?: ReactNode
}) {
	const statusClass =
		host.status === 'ready' ? 'text-green-600' : host.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'
	const facts = [
		CLOUD_HOST_PROVIDER_LABELS[host.provider],
		host.status === 'destroying' ? null : describeCloudHostExpiry(host.expiresAt, now),
	].filter((fact): fact is string => Boolean(fact))

	return (
		<div className="bg-muted/50 rounded-md px-3 py-2" data-testid={`cloud-host-${host.hostId}`}>
			<div className="flex flex-wrap items-center gap-3">
				{isCloudHostSettling(host.status) ? (
					<Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
				) : (
					<Cloud aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<div className="flex-1 min-w-0">
					<span className="text-sm font-medium">Cloud host</span>
					<span className="text-xs text-muted-foreground ml-2">({host.hostId.substring(0, 8)})</span>
					<span className="text-xs text-muted-foreground ml-2">{facts.join(' · ')}</span>
				</div>
				<span className={`text-xs font-medium ${statusClass}`}>{CLOUD_HOST_STATUS_LABELS[host.status]}</span>
				{canReadCloudHostLogs(host.status) && (
					<Button variant="ghost" size="sm" className="h-7" onClick={onToggleLogs}>
						{logsOpen ? 'Hide logs' : 'Show logs'}
					</Button>
				)}
				{host.status !== 'destroying' && (
					<Button variant="destructive" size="sm" aria-label="Delete cloud host" onClick={onDelete}>
						<Trash2 className="size-3.5" />
					</Button>
				)}
			</div>
			{host.error && <p className="mt-1 pl-6 text-xs text-red-600">{host.error}</p>}
			{children}
		</div>
	)
}

function WiredCloudHostLogs({ hostId }: { hostId: string }) {
	const logs = useCloudHostLogs(hostId, true)
	if (logs.isPending) {
		return (
			<p role="status" className="mt-2 pl-6 text-xs text-muted-foreground">
				Loading logs…
			</p>
		)
	}
	if (logs.isError) {
		return (
			<p className="mt-2 pl-6 text-xs text-muted-foreground">
				Could not load logs. The sandbox may already be gone.
			</p>
		)
	}
	return (
		<div className="mt-2 space-y-2 pl-6">
			<LogBlock title="Setup log" text={logs.data.bootstrap} />
			<LogBlock title="Daemon log" text={logs.data.daemon} />
		</div>
	)
}

function LogBlock({ title, text }: { title: string; text: string }) {
	return (
		<div>
			<p className="text-xs font-medium text-muted-foreground mb-1">{title}</p>
			<pre className="max-h-64 overflow-auto bg-background/60 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">
				{text.trim() || 'Empty'}
			</pre>
		</div>
	)
}

function CloudHostDeleteDialog({
	open,
	isPending,
	onOpenChange,
	onConfirm,
}: {
	open: boolean
	isPending: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent showCloseButton={!isPending}>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-destructive">
						<AlertTriangle className="size-4" />
						Delete cloud host?
					</DialogTitle>
					<DialogDescription>
						The sandbox and everything on it is deleted, and sessions running on this host stop. Existing
						sessions stay in your task list. This action cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm} disabled={isPending}>
						<Trash2 className="size-3.5" />
						{isPending ? 'Deleting…' : 'Delete'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
