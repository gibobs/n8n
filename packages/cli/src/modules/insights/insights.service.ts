import { type InsightsSummary, type InsightsDateRange } from '@n8n/api-types';
import { LicenseState, Logger } from '@n8n/backend-common';
import { OnLeaderStepdown, OnLeaderTakeover, OnShutdown } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { UserError } from 'n8n-workflow';

import type { PeriodUnit, TypeUnit } from './database/entities/insights-shared';
import { NumberToType } from './database/entities/insights-shared';
import { InsightsByPeriodRepository } from './database/repositories/insights-by-period.repository';
import { InsightsCollectionService } from './insights-collection.service';
import { InsightsCompactionService } from './insights-compaction.service';
import { getAvailableDateRanges, keyRangeToDays } from './insights-helpers';
import { InsightsPruningService } from './insights-pruning.service';

@Service()
export class InsightsService {
	constructor(
		private readonly insightsByPeriodRepository: InsightsByPeriodRepository,
		private readonly compactionService: InsightsCompactionService,
		private readonly collectionService: InsightsCollectionService,
		private readonly pruningService: InsightsPruningService,
		private readonly licenseState: LicenseState,
		private readonly instanceSettings: InstanceSettings,
		private readonly logger: Logger,
	) {
		this.logger = this.logger.scoped('insights');
	}

	@OnLeaderTakeover()
	startTimers() {
		this.collectionService.startFlushingTimer();

		if (this.instanceSettings.isLeader) this.startCompactionAndPruningTimers();
	}

	@OnLeaderTakeover()
	startCompactionAndPruningTimers() {
		this.compactionService.startCompactionTimer();
		if (this.pruningService.isPruningEnabled) {
			this.pruningService.startPruningTimer();
		}
	}

	@OnLeaderStepdown()
	stopCompactionAndPruningTimers() {
		this.compactionService.stopCompactionTimer();
		this.pruningService.stopPruningTimer();
	}

	@OnShutdown()
	async shutdown() {
		await this.collectionService.shutdown();
		this.stopCompactionAndPruningTimers();
	}

	async getInsightsSummary({
		periodLengthInDays,
	}: { periodLengthInDays: number }): Promise<InsightsSummary> {
		const rows = await this.insightsByPeriodRepository.getPreviousAndCurrentPeriodTypeAggregates({
			periodLengthInDays,
		});

		// Initialize data structures for both periods
		const data = {
			current: { byType: {} as Record<TypeUnit, number> },
			previous: { byType: {} as Record<TypeUnit, number> },
		};

		// Organize data by period and type
		rows.forEach((row) => {
			const { period, type, total_value } = row;
			if (!data[period]) return;

			data[period].byType[NumberToType[type]] = total_value ? Number(total_value) : 0;
		});

		// Get values with defaults for missing data
		const getValueByType = (period: 'current' | 'previous', type: TypeUnit) =>
			data[period]?.byType[type] ?? 0;

		// Calculate metrics
		const currentSuccesses = getValueByType('current', 'success');
		const currentFailures = getValueByType('current', 'failure');
		const previousSuccesses = getValueByType('previous', 'success');
		const previousFailures = getValueByType('previous', 'failure');

		const currentTotal = currentSuccesses + currentFailures;
		const previousTotal = previousSuccesses + previousFailures;

		const currentFailureRate =
			currentTotal > 0 ? Math.round((currentFailures / currentTotal) * 1000) / 1000 : 0;
		const previousFailureRate =
			previousTotal > 0 ? Math.round((previousFailures / previousTotal) * 1000) / 1000 : 0;

		const currentTotalRuntime = getValueByType('current', 'runtime_ms') ?? 0;
		const previousTotalRuntime = getValueByType('previous', 'runtime_ms') ?? 0;

		const currentAvgRuntime =
			currentTotal > 0 ? Math.round((currentTotalRuntime / currentTotal) * 100) / 100 : 0;
		const previousAvgRuntime =
			previousTotal > 0 ? Math.round((previousTotalRuntime / previousTotal) * 100) / 100 : 0;

		const currentTimeSaved = getValueByType('current', 'time_saved_min');
		const previousTimeSaved = getValueByType('previous', 'time_saved_min');

		// If the previous period has no executions, we discard deviation
		const getDeviation = (current: number, previous: number) =>
			previousTotal === 0 ? null : current - previous;

		// Return the formatted result
		const result: InsightsSummary = {
			averageRunTime: {
				value: currentAvgRuntime,
				unit: 'millisecond',
				deviation: getDeviation(currentAvgRuntime, previousAvgRuntime),
			},
			failed: {
				value: currentFailures,
				unit: 'count',
				deviation: getDeviation(currentFailures, previousFailures),
			},
			failureRate: {
				value: currentFailureRate,
				unit: 'ratio',
				deviation: getDeviation(currentFailureRate, previousFailureRate),
			},
			timeSaved: {
				value: currentTimeSaved,
				unit: 'minute',
				deviation: getDeviation(currentTimeSaved, previousTimeSaved),
			},
			total: {
				value: currentTotal,
				unit: 'count',
				deviation: getDeviation(currentTotal, previousTotal),
			},
		};

		return result;
	}

	async getInsightsByWorkflow({
		maxAgeInDays,
		skip = 0,
		take = 10,
		sortBy = 'total:desc',
	}: {
		maxAgeInDays: number;
		skip?: number;
		take?: number;
		sortBy?: string;
	}) {
		const { count, rows } = await this.insightsByPeriodRepository.getInsightsByWorkflow({
			maxAgeInDays,
			skip,
			take,
			sortBy,
		});

		return {
			count,
			data: rows,
		};
	}

	async getInsightsByTime({
		maxAgeInDays,
		periodUnit,
	}: { maxAgeInDays: number; periodUnit: PeriodUnit }) {
		const rows = await this.insightsByPeriodRepository.getInsightsByTime({
			maxAgeInDays,
			periodUnit,
		});

		return rows.map((r) => {
			const total = r.succeeded + r.failed;
			return {
				date: r.periodStart,
				values: {
					total,
					succeeded: r.succeeded,
					failed: r.failed,
					failureRate: r.failed / total,
					averageRunTime: r.runTime / total,
					timeSaved: r.timeSaved,
				},
			};
		});
	}

	getMaxAgeInDaysAndGranularity(
		dateRangeKey: InsightsDateRange['key'],
	): InsightsDateRange & { maxAgeInDays: number } {
		const dateRange = getAvailableDateRanges(this.licenseState).find(
			(range) => range.key === dateRangeKey,
		);
		if (!dateRange) {
			// Not supposed to happen if we trust the dateRangeKey type
			throw new UserError('The selected date range is not available');
		}

		if (!dateRange.licensed) {
			throw new UserError(
				'The selected date range exceeds the maximum history allowed by your license.',
			);
		}

		return { ...dateRange, maxAgeInDays: keyRangeToDays[dateRangeKey] };
	}
}
