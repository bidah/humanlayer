import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NewCloudHostDialog, type NewCloudHostInput } from './NewCloudHostDialog'

beforeEach(() => {
	// Radix radio groups measure their items.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const PROVIDERS = [
	{ provider: 'cloudflare' as const, available: true },
	{ provider: 'daytona' as const, available: true },
	{ provider: 'e2b' as const, available: false },
]

function renderDialog(overrides: Partial<Parameters<typeof NewCloudHostDialog>[0]> = {}) {
	const onCreate = vi.fn<(input: NewCloudHostInput) => void>()
	render(
		<NewCloudHostDialog
			open
			providers={PROVIDERS}
			isCreating={false}
			onOpenChange={() => {}}
			onCreate={onCreate}
			{...overrides}
		/>,
	)
	return { onCreate }
}

describe('NewCloudHostDialog', () => {
	it('defaults to Cloudflare and marks a provider this deployment lacks as unavailable', () => {
		renderDialog()
		expect(screen.getByRole('radio', { name: /Cloudflare/ })).toBeChecked()
		const e2b = screen.getByRole('radio', { name: /E2B/ })
		expect(e2b).toBeDisabled()
		expect(screen.getByText('Not available on this deployment')).toBeInTheDocument()
	})

	it('creates with the default time limit and no credentials when the fields are empty', () => {
		const { onCreate } = renderDialog()
		fireEvent.click(screen.getByRole('button', { name: 'Create host' }))
		expect(onCreate).toHaveBeenCalledWith({ provider: 'cloudflare', ttlMinutes: 24 * 60 })
	})

	it('passes Daytona size and only the credentials that were filled in', () => {
		const { onCreate } = renderDialog()
		fireEvent.click(screen.getByRole('radio', { name: /Daytona/ }))
		fireEvent.click(screen.getByRole('radio', { name: /Large/ }))
		fireEvent.click(screen.getByRole('radio', { name: '4 hours' }))
		fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: ' sk-ant-test ' } })
		fireEvent.change(screen.getByLabelText('GitHub token'), { target: { value: 'ghp_test' } })
		fireEvent.click(screen.getByRole('button', { name: 'Create host' }))
		expect(onCreate).toHaveBeenCalledWith({
			provider: 'daytona',
			ttlMinutes: 240,
			size: 'large',
			credentials: { anthropicApiKey: 'sk-ant-test', githubToken: 'ghp_test' },
		})
	})

	it('keeps credential fields masked', () => {
		renderDialog()
		expect(screen.getByLabelText('Claude Code OAuth token')).toHaveAttribute('type', 'password')
	})

	it('cannot create while no provider is available', () => {
		const { onCreate } = renderDialog({ providers: PROVIDERS.map((p) => ({ ...p, available: false })) })
		expect(screen.getByRole('button', { name: 'Create host' })).toBeDisabled()
		expect(screen.getByText(/Cloud hosts are not set up on this deployment/)).toBeInTheDocument()
		expect(onCreate).not.toHaveBeenCalled()
	})

	it('shows progress and blocks a second submit while creating', () => {
		renderDialog({ isCreating: true })
		expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
	})
})
