import type { Meta, StoryObj } from '@storybook/react-vite';
import { MediaFrame } from '../src/components/MediaFrame/MediaFrame';
import { Heading, Kicker, Meta as MetaRow, Text } from '../src/components/Typography/Typography';
import { coverFor, listArtworks, listPhotos, type MediaKind } from '../src/media/index';

const meta = { title: 'Media/Covers and photographs', component: MediaFrame } satisfies Meta<typeof MediaFrame>;
export default meta;
type Story = StoryObj;

export const Ratios: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
      {(['21/9', '16/10', '4/3', '1/1', '3/4'] as const).map((ratio, index) => (
        <div key={ratio}>
          <Kicker>{ratio}</Kicker>
          <MediaFrame media={listPhotos()[index] ?? listPhotos()[0]!} ratio={ratio} />
        </div>
      ))}
    </div>
  ),
};

export const ScrimsWithText: Story = {
  name: 'Scrims with white text (AA)',
  render: () => (
    <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
      {(['bottom', 'left', 'full'] as const).map((scrim, index) => (
        <div key={scrim} data-testid={`scrim-${scrim}`}>
          <MediaFrame media={listPhotos()[index + 2] ?? listPhotos()[0]!} ratio="16/10" scrim={scrim}>
            <Kicker tone="inverse">scrim · {scrim}</Kicker>
            <Heading level={3} tone="inverse">
              Белый текст поверх фотографии
            </Heading>
            <MetaRow items={['Редакция', '6 мин']} tone="inverse" />
          </MediaFrame>
        </div>
      ))}
    </div>
  ),
};

export const Photographs: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {listPhotos().map((item) => (
        <figure key={item.id} style={{ margin: 0 }}>
          <MediaFrame media={item} ratio="4/3" radius="card" sizes="240px" />
          <figcaption>
            <Text styleAs="caption" tone="muted">
              {item.id} · {item.author} · {item.license}
            </Text>
          </figcaption>
        </figure>
      ))}
    </div>
  ),
};

export const Artworks: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {listArtworks().map((item) => (
        <figure key={item.id} style={{ margin: 0 }}>
          <MediaFrame media={item} ratio="16/10" radius="card" />
          <figcaption>
            <Text styleAs="caption" tone="muted">
              {item.id} · {item.alt}
            </Text>
          </figcaption>
        </figure>
      ))}
    </div>
  ),
};

const kinds: MediaKind[] = ['article', 'news', 'company', 'person', 'project', 'material', 'site', 'magazine'];

export const DeterministicAssignment: Story = {
  name: 'coverFor(kind, seed)',
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      {kinds.map((kind) => (
        <div key={kind}>
          <Kicker>{kind}</Kicker>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(6, 1fr)' }}>
            {[1, 2, 3, 4, 5, 6].map((seed) => {
              const ref = coverFor(kind, `${kind}-${seed}`);
              return (
                <figure key={seed} style={{ margin: 0 }}>
                  <MediaFrame media={ref} ratio="16/10" radius="card" sizes="160px" />
                  <figcaption>
                    <Text styleAs="caption" tone="muted">
                      {ref.type === 'photo' ? 'фото' : 'арт'} · {ref.id}
                    </Text>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  ),
};
