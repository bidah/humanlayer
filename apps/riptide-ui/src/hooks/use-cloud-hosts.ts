import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { isCloudHostSettling, isCloudHostStarting } from '@/lib/cloud-host-status'
import { useRiptideApi } from '@/orpc/client'

const SETTLING_POLL_MS = 3_000
const IDLE_POLL_MS = 30_000

/** Which providers this deployment can start cloud hosts on (asked of the API, not hard-coded). */
export function useCloudHostProviders(enabled = true) {
	const { queryClient: api } = useRiptideApi()
	return useQuery({
		...api.hosts.cloud.providers.queryOptions({ input: {}, context: { silent: true } }),
		enabled,
		staleTime: 60_000,
	})
}

/** The caller's live cloud hosts; polls faster while any of them is changing. */
export function useCloudHosts() {
	const { queryClient: api } = useRiptideApi()
	return useQuery({
		...api.hosts.cloud.list.queryOptions({ input: {}, context: { silent: true } }),
		refetchInterval: (query) =>
			query.state.data?.hosts.some((host) => isCloudHostSettling(host.status)) ? SETTLING_POLL_MS : IDLE_POLL_MS,
	})
}

/**
 * One cloud host's status, polled while it is starting. `get` also asks the provisioner for
 * progress, so this is what moves a host from "Starting sandbox" to "Installing daemon".
 */
export function useCloudHostProgress(hostId: string, starting: boolean) {
	const { queryClient: api } = useRiptideApi()
	return useQuery({
		...api.hosts.cloud.get.queryOptions({ input: { hostId }, context: { silent: true } }),
		enabled: starting,
		refetchInterval: (query) =>
			!query.state.data || isCloudHostStarting(query.state.data.host.status) ? SETTLING_POLL_MS : false,
	})
}

export function useCloudHostLogs(hostId: string, enabled: boolean) {
	const { queryClient: api } = useRiptideApi()
	return useQuery({
		...api.hosts.cloud.logs.queryOptions({ input: { hostId, lines: 200 }, context: { silent: true } }),
		enabled,
		retry: false,
	})
}

function useInvalidateCloudHosts() {
	const { queryClient: api } = useRiptideApi()
	const queryClient = useQueryClient()
	return () =>
		Promise.allSettled([
			queryClient.invalidateQueries({ queryKey: api.hosts.cloud.key() }),
			queryClient.invalidateQueries({ queryKey: ['sync', 'onlineHosts'] }),
		])
}

export function useCreateCloudHost() {
	const { client } = useRiptideApi()
	const invalidate = useInvalidateCloudHosts()
	return useMutation({
		// Creating twice would start two sandboxes.
		retry: false,
		mutationFn: (input: Parameters<typeof client.hosts.cloud.create>[0]) =>
			client.hosts.cloud.create(input, { context: { silent: true } }),
		onSettled: () => void invalidate(),
	})
}

export function useDestroyCloudHost() {
	const { client } = useRiptideApi()
	const invalidate = useInvalidateCloudHosts()
	return useMutation({
		mutationFn: (params: { hostId: string }) => client.hosts.cloud.destroy(params, { context: { silent: true } }),
		onSettled: () => void invalidate(),
	})
}
