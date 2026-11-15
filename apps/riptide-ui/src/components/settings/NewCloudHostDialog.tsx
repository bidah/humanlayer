import type { CloudHostProvider, CloudHostSize } from '@humanlayer/db/tables/cloud-hosts'
import { Button } from '@humanlayer/ui/components/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@humanlayer/ui/components/dialog'
import { Input } from '@humanlayer/ui/components/input'
import { Label } from '@humanlayer/ui/components/label'
import { RadioGroup, RadioGroupItem } from '@humanlayer/ui/components/radio-group'
import { Cloud } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import {
	CLOUD_HOST_DEFAULT_TTL_MINUTES,
	CLOUD_HOST_PROVIDER_LABELS,
	E2B_MAX_TTL_MINUTES,
	ttlOptionsFor,
} from '@/lib/cloud-host-status'

export interface CloudHostProviderOption {
	provider: CloudHostProvider
	available: boolean
}

export interface NewCloudHostInput {
	provider: CloudHostProvider
	ttlMinutes: number
	size?: CloudHostSize
	credentials?: { anthropicApiKey?: string; claudeCodeOauthToken?: string; githubToken?: string }
}

export interface NewCloudHostDialogProps {
	open: boolean
	/** Null while the API is being asked which providers this deployment has. */
	providers: readonly CloudHostProviderOption[] | null
	isCreating: boolean
	onOpenChange: (open: boolean) => void
	onCreate: (input: NewCloudHostInput) => void
}

const PROVIDER_ORDER: readonly CloudHostProvider[] = ['cloudflare', 'daytona', 'e2b']

const SIZE_OPTIONS: ReadonlyArray<{ size: CloudHostSize; label: string }> = [
	{ size: 'small', label: 'Small · 1 CPU, 2 GB' },
	{ size: 'medium', label: 'Medium · 2 CPUs, 4 GB' },
	{ size: 'large', label: 'Large · 4 CPUs, 8 GB' },
]

/** Start a host in a cloud sandbox: provider, time limit, and optional agent credentials. */
export function NewCloudHostDialog({ open, providers, isCreating, onOpenChange, onCreate }: NewCloudHostDialogProps) {
	return (
		<Dialog open={open} onOpenChange={(next) => !isCreating && onOpenChange(next)}>
			<DialogContent showCloseButton={!isCreating} className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Cloud className="size-4" />
						New cloud host
					</DialogTitle>
					<DialogDescription>
						The host appears in your host list once its daemon is online, usually within a minute.
					</DialogDescription>
				</DialogHeader>
				{/* Mounted only while open, so every open starts from a blank form. */}
				<NewCloudHostForm
					providers={providers}
					isCreating={isCreating}
					onCancel={() => onOpenChange(false)}
					onCreate={onCreate}
				/>
			</DialogContent>
		</Dialog>
	)
}

function NewCloudHostForm({
	providers,
	isCreating,
	onCancel,
	onCreate,
}: {
	providers: readonly CloudHostProviderOption[] | null
	isCreating: boolean
	onCancel: () => void
	onCreate: (input: NewCloudHostInput) => void
}) {
	const [chosenProvider, setChosenProvider] = useState<CloudHostProvider | null>(null)
	const [chosenTtl, setChosenTtl] = useState(CLOUD_HOST_DEFAULT_TTL_MINUTES)
	const [size, setSize] = useState<CloudHostSize>('medium')
	const [anthropicApiKey, setAnthropicApiKey] = useState('')
	const [claudeCodeOauthToken, setClaudeCodeOauthToken] = useState('')
	const [githubToken, setGithubToken] = useState('')

	const isAvailable = (provider: CloudHostProvider) =>
		providers?.some((option) => option.provider === provider && option.available) ?? false
	const firstAvailable = PROVIDER_ORDER.find(isAvailable) ?? null
	const provider = chosenProvider && isAvailable(chosenProvider) ? chosenProvider : firstAvailable
	const ttlMinutes = provider === 'e2b' ? Math.min(chosenTtl, E2B_MAX_TTL_MINUTES) : chosenTtl
	const noneAvailable = providers !== null && firstAvailable === null

	const submit = (event: FormEvent) => {
		event.preventDefault()
		if (!provider || isCreating) return
		const input: NewCloudHostInput = { provider, ttlMinutes }
		if (provider === 'daytona') input.size = size
		const credentials: NonNullable<NewCloudHostInput['credentials']> = {}
		if (anthropicApiKey.trim()) credentials.anthropicApiKey = anthropicApiKey.trim()
		if (claudeCodeOauthToken.trim()) credentials.claudeCodeOauthToken = claudeCodeOauthToken.trim()
		if (githubToken.trim()) credentials.githubToken = githubToken.trim()
		if (Object.keys(credentials).length > 0) input.credentials = credentials
		onCreate(input)
	}

	return (
		<form className="space-y-5" onSubmit={submit} autoComplete="off">
			<fieldset className="space-y-2">
				<legend className="text-xs font-medium text-muted-foreground">Provider</legend>
				{providers === null ? (
					<p role="status" className="text-sm text-muted-foreground">
						Checking which providers are available…
					</p>
				) : (
					<RadioGroup
						value={provider ?? ''}
						onValueChange={(value) => setChosenProvider(value as CloudHostProvider)}
						aria-label="Provider"
						className="gap-2"
					>
						{PROVIDER_ORDER.map((option) => {
							const available = isAvailable(option)
							return (
								<div key={option} className="flex items-center gap-2">
									<RadioGroupItem
										id={`cloud-host-provider-${option}`}
										value={option}
										disabled={!available || isCreating}
									/>
									<Label
										htmlFor={`cloud-host-provider-${option}`}
										className={available ? 'text-sm' : 'text-sm text-muted-foreground'}
									>
										{CLOUD_HOST_PROVIDER_LABELS[option]}
										{option === 'cloudflare' && available && (
											<span className="text-xs text-muted-foreground">Default</span>
										)}
										{!available && (
											<span className="text-xs text-muted-foreground">
												Not available on this deployment
											</span>
										)}
									</Label>
								</div>
							)
						})}
					</RadioGroup>
				)}
				{noneAvailable && (
					<p className="text-sm text-destructive">
						Cloud hosts are not set up on this deployment. Ask an admin to configure a provider.
					</p>
				)}
			</fieldset>

			<fieldset className="space-y-2">
				<legend className="text-xs font-medium text-muted-foreground">Time limit</legend>
				<RadioGroup
					value={String(ttlMinutes)}
					onValueChange={(value) => setChosenTtl(Number(value))}
					aria-label="Time limit"
					className="flex flex-wrap gap-4"
				>
					{ttlOptionsFor(provider ?? 'cloudflare').map((option) => (
						<div key={option.minutes} className="flex items-center gap-2">
							<RadioGroupItem
								id={`cloud-host-ttl-${option.minutes}`}
								value={String(option.minutes)}
								disabled={isCreating}
							/>
							<Label htmlFor={`cloud-host-ttl-${option.minutes}`} className="text-sm">
								{option.label}
							</Label>
						</div>
					))}
				</RadioGroup>
				<p className="text-xs text-muted-foreground">
					The host and everything on it is deleted when the time is up.
				</p>
			</fieldset>

			{provider === 'daytona' && (
				<fieldset className="space-y-2">
					<legend className="text-xs font-medium text-muted-foreground">Size</legend>
					<RadioGroup
						value={size}
						onValueChange={(value) => setSize(value as CloudHostSize)}
						aria-label="Size"
						className="gap-2"
					>
						{SIZE_OPTIONS.map((option) => (
							<div key={option.size} className="flex items-center gap-2">
								<RadioGroupItem
									id={`cloud-host-size-${option.size}`}
									value={option.size}
									disabled={isCreating}
								/>
								<Label htmlFor={`cloud-host-size-${option.size}`} className="text-sm">
									{option.label}
								</Label>
							</div>
						))}
					</RadioGroup>
				</fieldset>
			)}

			<fieldset className="space-y-3">
				<legend className="text-xs font-medium text-muted-foreground">Agent credentials (optional)</legend>
				<p className="text-xs text-muted-foreground">
					Passed to the host and not stored by HumanLayer. Leave them empty to sign in to the agent from the
					app once the host is ready.
				</p>
				<CredentialField
					id="cloud-host-anthropic-api-key"
					label="Anthropic API key"
					placeholder="Starts with sk-ant-"
					value={anthropicApiKey}
					disabled={isCreating}
					onChange={setAnthropicApiKey}
				/>
				<CredentialField
					id="cloud-host-claude-code-oauth-token"
					label="Claude Code OAuth token"
					placeholder="From claude setup-token"
					value={claudeCodeOauthToken}
					disabled={isCreating}
					onChange={setClaudeCodeOauthToken}
				/>
				<CredentialField
					id="cloud-host-github-token"
					label="GitHub token"
					placeholder="Lets the agent clone and push"
					value={githubToken}
					disabled={isCreating}
					onChange={setGithubToken}
				/>
			</fieldset>

			<DialogFooter>
				<Button type="button" variant="secondary" onClick={onCancel} disabled={isCreating}>
					Cancel
				</Button>
				<Button type="submit" disabled={!provider || isCreating}>
					{isCreating ? 'Creating…' : 'Create host'}
				</Button>
			</DialogFooter>
		</form>
	)
}

function CredentialField({
	id,
	label,
	placeholder,
	value,
	disabled,
	onChange,
}: {
	id: string
	label: string
	placeholder: string
	value: string
	disabled: boolean
	onChange: (value: string) => void
}) {
	return (
		<div className="space-y-1">
			<Label htmlFor={id} className="text-sm">
				{label}
			</Label>
			<Input
				id={id}
				type="password"
				autoComplete="off"
				spellCheck={false}
				placeholder={placeholder}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				className="h-8 font-mono text-xs"
			/>
		</div>
	)
}
