import {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricDataInput,
  GetMetricDataOutput,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import {AirbyteLogger} from 'faros-airbyte-cdk';
import _ from 'lodash';
import {VError} from 'verror';

export const MIN_DATE = new Date(0).toISOString();
// January 1, 2200
export const MAX_DATE = new Date(7258118400000).toISOString();

const DEFAULT_CUTOFF_DAYS = 90;
const DEFAULT_PAGE_SIZE = 100;

export interface NamedQuery {
  name: string;
  query: string;
}

export interface DataPoint {
  timestamp: string;
  value: number;
  label: string;
}

export interface Config {
  aws_region: string;
  credentials: {
    aws_access_key_id: string;
    aws_secret_access_key: string;
    aws_session_token?: string;
  };
  queries: ReadonlyArray<NamedQuery>;
  page_size?: number;
  cutoff_days?: number;
  stream_name?: string;
}

export class CloudWatch {
  private static cloudWatch: CloudWatch;

  constructor(
    private readonly client: CloudWatchClient,
    private readonly startDate: string,
    private readonly endDate: string,
    private readonly pageSize: number
  ) {}

  static instance(config: Config): CloudWatch {
    if (CloudWatch.cloudWatch) return CloudWatch.cloudWatch;

    if (!config.aws_region) {
      throw new VError('Please specify AWS region');
    }
    if (!config.credentials) {
      throw new VError('Please specify AWS credentials');
    }
    if (!config.credentials.aws_access_key_id) {
      throw new VError('Please specify AWS access key ID');
    }
    if (!config.credentials.aws_secret_access_key) {
      throw new VError('Please specify AWS secret access key');
    }

    if (config.queries.length === 0) {
      throw new Error('Please specify at least one query');
    }

    for (const query of config.queries) {
      if (!query.name || !query.query) {
        throw new Error('Please specify a name and query for each query');
      }

      try {
        JSON.parse(query.query);
      } catch {
        throw new Error(`Query ${query.name} is not valid JSON`);
      }
    }

    const cutoffDays = config.cutoff_days ?? DEFAULT_CUTOFF_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const startDate = cutoffDate.toISOString();
    const endDate = new Date().toISOString();

    const client = new CloudWatchClient({
      region: config.aws_region,
      credentials: {
        accessKeyId: config.credentials.aws_access_key_id,
        secretAccessKey: config.credentials.aws_secret_access_key,
        sessionToken: config.credentials.aws_session_token,
      },
    });

    CloudWatch.cloudWatch = new CloudWatch(
      client,
      startDate,
      endDate,
      config.page_size ?? DEFAULT_PAGE_SIZE
    );

    return CloudWatch.cloudWatch;
  }

  async checkConnection(): Promise<void> {
    await this.client.send(new ListMetricsCommand({}));
  }

  async *getMetricData(
    query: string,
    after?: string,
    logger?: AirbyteLogger
  ): AsyncGenerator<DataPoint> {
    const params: GetMetricDataInput = {
      StartTime: new Date(after ?? this.startDate),
      EndTime: new Date(this.endDate),
      MaxDatapoints: this.pageSize,
      MetricDataQueries: [JSON.parse(query)],
    };

    do {
      const command = new GetMetricDataCommand(params);
      const response: GetMetricDataOutput = await this.client.send(command);

      for (const result of response.MetricDataResults ?? []) {
        for (const [t, v] of _.zip(result.Timestamps, result.Values)) {
          if (t === undefined || v === undefined) continue;
          yield {
            timestamp: t.toISOString(),
            value: v,
            label: result.Label,
          };
        }
        logger?.info(`Fetched ${result.Timestamps?.length} data points`);
      }

      params.NextToken = response?.NextToken;
    } while (params.NextToken);
  }
}
