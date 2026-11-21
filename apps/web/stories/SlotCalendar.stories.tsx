import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SlotCalendar } from '../src/SlotCalendar.js';
const data = {
  configured: true,
  serverNow: '2026-10-25T00:00:00.000Z',
  timeZone: 'Europe/Berlin',
  windowStartsAt: '2026-10-24T22:00:00.000Z',
  windowEndsAt: '2026-11-07T23:00:00.000Z',
  slots: [
    { startsAt: '2026-10-25T00:30:00.000Z', endsAt: '2026-10-25T00:50:00.000Z' },
    { startsAt: '2026-10-25T01:30:00.000Z', endsAt: '2026-10-25T01:50:00.000Z' },
  ],
};
const meta = {
  component: SlotCalendar,
  title: 'Запись/Календарь Слотов',
  args: {
    data,
    timeZone: 'Europe/Berlin',
    day: '2026-10-25',
    loading: false,
    error: false,
    onDayChange: () => {},
    onRetry: () => {},
  },
  render: function CalendarStory(args) {
    const [day, setDay] = useState(args.day);
    return <SlotCalendar {...args} day={day} onDayChange={setDay} />;
  },
} satisfies Meta<typeof SlotCalendar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: { ...data, slots: [] } } };
export const Unconfigured: Story = {
  args: {
    data: {
      ...data,
      configured: false,
      timeZone: null,
      windowStartsAt: null,
      windowEndsAt: null,
      slots: [],
    },
  },
};
export const Failed: Story = { args: { data: undefined, error: true } };
export const Stale: Story = { args: { error: true } };
export const CrossingMidnight: Story = {
  args: {
    data: {
      ...data,
      slots: [{ startsAt: '2026-10-25T22:45:00.000Z', endsAt: '2026-10-25T23:15:00.000Z' }],
    },
  },
};
