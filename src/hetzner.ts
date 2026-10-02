import axios, { AxiosInstance, isAxiosError } from 'axios';

const HETZNER_API_BASE_URL = 'https://api.hetzner.cloud/v1';

/**
 * Error thrown for any problem while talking to the Hetzner Cloud API.
 * Carries a human-readable message that is safe to print/log.
 */
export class HetznerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HetznerApiError';
  }
}

interface Price {
  location: string;
  price_hourly: { net: string; gross: string };
  price_monthly: { net: string; gross: string };
}

/** Deprecation info for a server type in a specific location. */
interface LocationDeprecation {
  /** ISO date; once in the past the type is permanently unavailable here. */
  unavailable_after?: string;
  announced?: string;
}

/**
 * Per-location availability for a server type (new API shape, replacing the
 * removed `/datacenters` endpoint).
 */
interface ServerTypeLocation {
  id: number;
  name: string;
  /** True when the type can currently be created in this location. */
  available: boolean;
  recommended: boolean;
  deprecation: LocationDeprecation | null;
}

interface ServerType {
  id: number;
  name: string;
  cores: number;
  memory: number; // in GB
  disk: number; // in GB
  cpu_type: string; // "shared" | "dedicated"
  prices: Price[];
  /** Supported locations + per-location availability/deprecation details. */
  locations: ServerTypeLocation[];
}

interface ServerTypesResponse {
  server_types: ServerType[];
}

/** Human-friendly, currency-aware specs for a server type. */
export interface ServerTypeSpec {
  name: string;
  cores: number;
  cpuType: string;
  memoryGb: number;
  diskGb: number;
  /** Gross prices (EUR) per location name. */
  priceByLocation: Map<string, { hourlyGross: number; monthlyGross: number }>;
}

/**
 * Thin wrapper around the official Hetzner Cloud REST API.
 *
 * Availability strategy (no resources are ever created):
 * The `/server_types` endpoint exposes, for every server type, a `locations[]`
 * array describing in which locations the type is supported and whether it is
 * currently `available` for creation. (This replaces the old `/datacenters`
 * endpoint, which Hetzner removed on 2026-10-01 and now returns HTTP 410.)
 * A single `/server_types` request is both side-effect-free and sufficient.
 */
/** Maps each requested server type name to its available locations. */
export type AvailabilityMap = Map<string, string[]>;

export class HetznerClient {
  private readonly http: AxiosInstance;
  /** Cache of server type name (lowercase) -> full server type object. */
  private cachedServerTypes: Map<string, ServerType> | null = null;

  constructor(apiToken: string) {
    this.http = axios.create({
      baseURL: HETZNER_API_BASE_URL,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Resolves and caches the requested server types (id + specs + prices).
   * Throws if any requested name is unknown.
   */
  private async resolveServerTypes(
    serverTypeNames: string[],
  ): Promise<Map<string, ServerType>> {
    if (this.cachedServerTypes === null) {
      try {
        const { data } = await this.http.get<ServerTypesResponse>(
          '/server_types',
          { params: { per_page: 100 } },
        );
        const map = new Map<string, ServerType>();
        for (const type of data.server_types) {
          map.set(type.name.toLowerCase(), type);
        }
        this.cachedServerTypes = map;
      } catch (error) {
        throw this.toApiError(error);
      }
    }

    const result = new Map<string, ServerType>();
    const unknown: string[] = [];
    for (const name of serverTypeNames) {
      const type = this.cachedServerTypes.get(name.toLowerCase());
      if (type === undefined) {
        unknown.push(name);
      } else {
        result.set(name.toLowerCase(), type);
      }
    }

    if (unknown.length > 0) {
      const known = Array.from(this.cachedServerTypes.keys()).sort().join(', ');
      throw new HetznerApiError(
        `Unknown server type(s): ${unknown.join(', ')}. Known types: ${known}`,
      );
    }

    return result;
  }

  /**
   * Returns human-friendly specs (cores, memory, disk, per-location prices)
   * for a server type. Only valid after an availability check has populated
   * the cache; returns null otherwise or for unknown names.
   */
  getSpec(serverTypeName: string): ServerTypeSpec | null {
    const type = this.cachedServerTypes?.get(serverTypeName.toLowerCase());
    if (!type) {
      return null;
    }

    const priceByLocation = new Map<
      string,
      { hourlyGross: number; monthlyGross: number }
    >();
    for (const price of type.prices) {
      priceByLocation.set(price.location.toLowerCase(), {
        hourlyGross: Number.parseFloat(price.price_hourly.gross),
        monthlyGross: Number.parseFloat(price.price_monthly.gross),
      });
    }

    return {
      name: type.name,
      cores: type.cores,
      cpuType: type.cpu_type,
      memoryGb: type.memory,
      diskGb: type.disk,
      priceByLocation,
    };
  }

  /**
   * For every requested server type, returns the subset of `locations` where
   * it is currently available for creation, based on the server type's
   * `locations[]` data. No extra request is needed beyond `/server_types`.
   */
  async getAvailability(
    serverTypeNames: string[],
    locations: string[],
  ): Promise<AvailabilityMap> {
    const typeByName = await this.resolveServerTypes(serverTypeNames);
    const wanted = locations.map((location) => location.toLowerCase());

    const result: AvailabilityMap = new Map();
    for (const name of serverTypeNames) {
      const key = name.toLowerCase();
      const type = typeByName.get(key);

      // Index this type's locations by name for quick lookup.
      const byLocation = new Map<string, ServerTypeLocation>();
      for (const loc of type?.locations ?? []) {
        byLocation.set(loc.name.toLowerCase(), loc);
      }

      // Keep only requested locations where the type is available right now,
      // preserving the caller's original ordering.
      const available = wanted.filter((location) =>
        this.isAvailableAt(byLocation.get(location)),
      );
      result.set(key, available);
    }

    return result;
  }

  /**
   * Decides whether a server type is currently available for creation in a
   * given location entry: it must exist (supported), be flagged available,
   * and not be permanently retired (deprecation date in the past).
   */
  private isAvailableAt(loc: ServerTypeLocation | undefined): boolean {
    if (!loc || !loc.available) {
      return false;
    }
    const unavailableAfter = loc.deprecation?.unavailable_after;
    if (unavailableAfter) {
      const retireDate = new Date(unavailableAfter).getTime();
      if (Number.isFinite(retireDate) && retireDate <= Date.now()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Converts arbitrary errors (Axios/network/HTTP) into a HetznerApiError
   * with a clear, printable message.
   */
  private toApiError(error: unknown): HetznerApiError {
    if (error instanceof HetznerApiError) {
      return error;
    }

    if (isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        const apiError = (error.response.data as { error?: { message?: string; code?: string } })
          ?.error;
        const detail = apiError?.message ?? error.message;
        const code = apiError?.code ? ` (code: ${apiError.code})` : '';

        if (status === 401 || status === 403) {
          return new HetznerApiError(
            `Authentication failed (HTTP ${status})${code}: ${detail}. ` +
              `Check that API_TOKEN is valid.`,
          );
        }
        if (status === 429) {
          return new HetznerApiError(
            `Rate limited by Hetzner API (HTTP 429)${code}: ${detail}.`,
          );
        }
        return new HetznerApiError(
          `Hetzner API error (HTTP ${status})${code}: ${detail}.`,
        );
      }

      if (error.code === 'ECONNABORTED') {
        return new HetznerApiError('Request to Hetzner API timed out.');
      }

      return new HetznerApiError(`Network error talking to Hetzner API: ${error.message}.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    return new HetznerApiError(`Unexpected error: ${message}.`);
  }
}
