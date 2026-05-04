import { Foo } from '../alpha/base/Foo';
import { Bar } from '../alpha/nested/Bar';

export function relayTags(): string {
    return `${new Foo().tag}|${new Bar().tag}`;
}
