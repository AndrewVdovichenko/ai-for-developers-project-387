import { Button, Card, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';
import type { EventType } from '@calendar/api-client';

export function EventTypeCard({ type }: { type: EventType }) {
  return (
    <Card withBorder component="article">
      <Stack>
        <Title order={2}>{type.name}</Title>
        {type.description && (
          <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {type.description}
          </Text>
        )}
        <Text>Длительность: {type.durationMinutes} мин.</Text>
        <Button component={Link} to={`/booking/${type.id}`}>
          Открыть страницу записи
        </Button>
      </Stack>
    </Card>
  );
}
