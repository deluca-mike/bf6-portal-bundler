/**
 * Expected `runBundlerFixture()` return value (`parts.join(';')`) — order matches `test/src/index.ts` `parts`.
 * Update when fixture sources or bundler resolution order changes.
 */
module.exports = [
    'alpha-base-Foo',
    'beta-base-Foo',
    'index-class-Foo',
    'i3',
    'alpha-nested-Bar',
    'beta-nested-Bar',
    'gamma-models-Baz',
    'gamma-deep-Baz',
    'waldo-a-class',
    'waldo-a-namespace',
    'waldo-b-class',
    'waldo-b-namespace',
    'pack-a-Data',
    'pack-b-Data',
    '1',
    'a',
    '10',
    '20',
    'f1-createId',
    'f2-createId',
    'e1:1',
    'alpha-base-Foo|alpha-nested-Bar',
    '1',
    '2',
    '3',
    'from-private-dup-a',
    'from-private-dup-b',
    'from-private-dup-index',
].join(';');
