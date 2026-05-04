import { Foo as FooAlpha } from './alpha/base/Foo';
import { Foo as FooBeta } from './beta/base/Foo';
import { Bar as BarAlpha } from './alpha/nested/Bar';
import { Bar as BarBeta } from './beta/nested/Bar';
import { Baz as BazShallow } from './gamma/models/Baz';
import { Baz as BazDeep } from './gamma/models/nested/deep/Baz';
import { Waldo as WaldoFirst } from './merged/waldo-a/Waldo';
import { Waldo as WaldoSecond } from './merged/waldo-b/Waldo';
import { Data as DataPackA } from './namespaces/pack-a/Data';
import { Data as DataPackB } from './namespaces/pack-b/inner/Data';
import type { Widget as WidgetA } from './types/t1/Widget';
import type { Widget as WidgetB } from './types/t2/Widget';
import { Phase as PhaseNumeric } from './enums/e1/Phase';
import { Phase as PhaseString } from './enums/e2/Phase';
import { THRESHOLD as ThresholdLow } from './consts/c1/THRESHOLD';
import { THRESHOLD as ThresholdHigh } from './consts/c2/THRESHOLD';
import type { Box as BoxI1 } from './interfaces/i1/Box';
import type { Box as BoxI2 } from './interfaces/i2/Box';
import { createId as createIdF1 } from './functions/f1/createId';
import { createId as createIdF2 } from './functions/f2/nested/createId';
import { acceptsI1Box } from './importStyles/inlineTypeImport';
import { phaseLabel } from './importStyles/mixedImport';
import { relayTags } from './delta/relay';
import { metric as metricV1 } from './vars/v1/metric';
import { metric as metricV2 } from './vars/v2/metric';
import { metric as metricV3 } from './vars/v3/nested/metric';

function useTypes(_a: WidgetA, _b: WidgetB, _c: BoxI1, _d: BoxI2): void {}

export function runBundlerFixture(): string {
    useTypes({ kind: 't1', v: 1 }, { kind: 't2', v: 'z' }, { slot: 'i1' }, { slot: 'i2' });

    acceptsI1Box({ slot: 'i1' });

    const parts = [
        new FooAlpha().tag,
        new FooBeta().tag,
        new BarAlpha().tag,
        new BarBeta().tag,
        new BazShallow().tag,
        new BazDeep().tag,
        WaldoFirst.fromClass,
        WaldoFirst.fromNs,
        WaldoSecond.fromClass,
        WaldoSecond.fromNs,
        DataPackA.token,
        DataPackB.token,
        String(PhaseNumeric.One),
        PhaseString.Alpha,
        ThresholdLow,
        ThresholdHigh,
        createIdF1(),
        createIdF2(),
        phaseLabel(PhaseNumeric.One),
        relayTags(),
        String(metricV1),
        String(metricV2),
        String(metricV3),
    ];

    return parts.join(';');
}
