import { AsyncLocalStorage } from "node:async_hooks";

export interface MetricsContext {
	workOrderId?: string;
	workItemId?: string;
	activityId?: string;
}

export const metricsStorage = new AsyncLocalStorage<MetricsContext>();

export function injectMetricsHeaders(headers: any): void {
	const store = metricsStorage.getStore();
	if (!store) return;

	const setHeader = (key: string, value: string) => {
		if (!headers) return;
		if (typeof headers.set === "function") {
			headers.set(key, value);
		} else if (typeof headers.append === "function") {
			headers.append(key, value);
		} else {
			headers[key] = value;
		}
	};

	if (store.workOrderId) setHeader("oc-metric-work-order-id", store.workOrderId);
	if (store.workItemId) setHeader("oc-metric-work-item-id", store.workItemId);
	if (store.activityId) setHeader("oc-metric-activity-id", store.activityId);
}
