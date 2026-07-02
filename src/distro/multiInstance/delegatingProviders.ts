// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  Tracer,
  TracerProvider,
  Span,
  SpanOptions,
  Context,
  Meter,
  MeterProvider,
  MeterOptions,
  MetricOptions,
  BatchObservableCallback,
  Observable,
  Counter,
  UpDownCounter,
  Gauge,
  Histogram,
  ObservableGauge,
  ObservableCounter,
  ObservableUpDownCounter,
} from "@opentelemetry/api";
import { createNoopMeter, ProxyTracerProvider } from "@opentelemetry/api";
import type { Logger, LoggerProvider, LoggerOptions, LogRecord } from "@opentelemetry/api-logs";
import { createNoopLogger } from "@opentelemetry/api-logs";

import { resolveInstanceProviders } from "./instanceRegistry.js";

// Shared fallbacks used when no instance is registered/resolved yet. They are
// no-ops so that early or out-of-band global API access never throws.
const NOOP_TRACER_PROVIDER = new ProxyTracerProvider();
const NOOP_METER = createNoopMeter();
const NOOP_LOGGER = createNoopLogger();

/**
 * A Tracer that resolves the current instance's tracer on every call. Resolution
 * MUST be per-call (never cached) because the ambient instance changes with the
 * active context.
 */
class DelegatingTracer implements Tracer {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: { schemaUrl?: string },
  ) {}

  private delegate(): Tracer {
    const providers = resolveInstanceProviders();
    const provider: TracerProvider = providers?.tracerProvider ?? NOOP_TRACER_PROVIDER;
    return provider.getTracer(this.name, this.version, this.options);
  }

  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    return this.delegate().startSpan(name, options, context);
  }

  // The api defines several overloads for startActiveSpan; forward all args.
  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    context: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan(name: string, ...args: unknown[]): unknown {
    return (this.delegate().startActiveSpan as (...a: unknown[]) => unknown)(name, ...args);
  }
}

/**
 * Global parent TracerProvider registered once. It owns no pipeline itself; it
 * delegates to the resolved child instance's TracerProvider.
 */
export class ParentTracerProvider implements TracerProvider {
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer {
    return new DelegatingTracer(name, version, options);
  }
}

/**
 * Base for synchronous instruments (counter / up-down-counter / histogram /
 * gauge). It re-resolves the current instance's `Meter` on every measurement so
 * `.add()` / `.record()` route by the ambient context at call time — not by the
 * instance that happened to be current when the instrument was created. The
 * concrete instrument is created once per resolved `Meter` and cached.
 */
class DelegatingSyncInstrument<T> {
  private readonly perMeter = new WeakMap<Meter, T>();
  constructor(
    private readonly resolveMeter: () => Meter,
    private readonly create: (meter: Meter) => T,
  ) {}

  protected target(): T {
    const meter = this.resolveMeter();
    let instrument = this.perMeter.get(meter);
    if (!instrument) {
      instrument = this.create(meter);
      this.perMeter.set(meter, instrument);
    }
    return instrument;
  }
}

class DelegatingCounter extends DelegatingSyncInstrument<Counter> implements Counter {
  add(...args: Parameters<Counter["add"]>): void {
    this.target().add(...args);
  }
}
class DelegatingUpDownCounter
  extends DelegatingSyncInstrument<UpDownCounter>
  implements UpDownCounter
{
  add(...args: Parameters<UpDownCounter["add"]>): void {
    this.target().add(...args);
  }
}
class DelegatingHistogram extends DelegatingSyncInstrument<Histogram> implements Histogram {
  record(...args: Parameters<Histogram["record"]>): void {
    this.target().record(...args);
  }
}
class DelegatingGauge extends DelegatingSyncInstrument<Gauge> implements Gauge {
  record(...args: Parameters<Gauge["record"]>): void {
    this.target().record(...args);
  }
}

/**
 * A Meter that routes measurements to the current instance.
 *
 * Synchronous instruments re-resolve the instance on every `.add()`/`.record()`
 * so they follow the ambient context. Observable instruments and batch
 * callbacks are collected asynchronously by a provider's reader, outside any
 * `runWithInstance` scope, so they cannot be ambient-routed — they bind to the
 * instance current at creation/registration time (the default when none is
 * active).
 */
class DelegatingMeter implements Meter {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: MeterOptions,
  ) {}

  private delegate(): Meter {
    const providers = resolveInstanceProviders();
    const provider: MeterProvider | undefined = providers?.meterProvider;
    return provider ? provider.getMeter(this.name, this.version, this.options) : NOOP_METER;
  }

  createGauge(name: string, options?: MetricOptions): Gauge {
    return new DelegatingGauge(
      () => this.delegate(),
      (meter) => meter.createGauge(name, options),
    );
  }
  createHistogram(name: string, options?: MetricOptions): Histogram {
    return new DelegatingHistogram(
      () => this.delegate(),
      (meter) => meter.createHistogram(name, options),
    );
  }
  createCounter(name: string, options?: MetricOptions): Counter {
    return new DelegatingCounter(
      () => this.delegate(),
      (meter) => meter.createCounter(name, options),
    );
  }
  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    return new DelegatingUpDownCounter(
      () => this.delegate(),
      (meter) => meter.createUpDownCounter(name, options),
    );
  }
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge {
    return this.delegate().createObservableGauge(name, options);
  }
  createObservableCounter(name: string, options?: MetricOptions): ObservableCounter {
    return this.delegate().createObservableCounter(name, options);
  }
  createObservableUpDownCounter(name: string, options?: MetricOptions): ObservableUpDownCounter {
    return this.delegate().createObservableUpDownCounter(name, options);
  }
  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.delegate().addBatchObservableCallback(callback, observables);
  }
  removeBatchObservableCallback(
    callback: BatchObservableCallback,
    observables: Observable[],
  ): void {
    this.delegate().removeBatchObservableCallback(callback, observables);
  }
}

/** Global parent MeterProvider registered once; delegates to the resolved child. */
export class ParentMeterProvider implements MeterProvider {
  getMeter(name: string, version?: string, options?: MeterOptions): Meter {
    return new DelegatingMeter(name, version, options);
  }
}

/** A Logger that resolves the current instance's logger on every emit. */
class DelegatingLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly version?: string,
    private readonly options?: LoggerOptions,
  ) {}

  private delegate(): Logger {
    const providers = resolveInstanceProviders();
    return providers
      ? providers.loggerProvider.getLogger(this.name, this.version, this.options)
      : NOOP_LOGGER;
  }

  emit(logRecord: LogRecord): void {
    this.delegate().emit(logRecord);
  }

  enabled(options?: Parameters<Logger["enabled"]>[0]): boolean {
    return this.delegate().enabled(options);
  }
}

/** Global parent LoggerProvider registered once; delegates to the resolved child. */
export class ParentLoggerProvider implements LoggerProvider {
  getLogger(name: string, version?: string, options?: LoggerOptions): Logger {
    return new DelegatingLogger(name, version, options);
  }
}
