'use client';

import { configureMedia } from '@trustwork/ui';
import { BASE_PATH } from '@/app/_lib/base-path';

configureMedia({ base: `${BASE_PATH}/media` });

/**
 * Client boundary for the design system. `@trustwork/ui` components are built on React Aria, which
 * needs the client runtime, so server components import them from here (each export becomes a
 * client reference). Only serializable props may cross this boundary: icons and render functions
 * are used inside client components in `components/**`. Media references from `coverFor()` are plain
 * objects (see `app/_lib/media.ts`) and cross the boundary as data.
 *
 * Why pages render `table.plain-table` instead of `DataTable`: `DataTable` takes `columns[].cell` render
 * functions and `rowKey`, which cannot be serialised across the client boundary from a server component,
 * and the fixture lists need no client-side sorting. `.plain-table` (app/globals.css) is a semantic table
 * with the same mobile card collapse (`data-label` per cell). WEB-002 should use `DataTable` inside its
 * client flows where sorting and row actions are needed.
 */
export {
  Avatar,
  AvatarButton,
  Badge,
  Band,
  Brand,
  Breadcrumb,
  Button,
  ButtonLink,
  Card,
  CardLink,
  Checkbox,
  DateTile,
  DecisionCard,
  Divider,
  EmptyState,
  EntityCard,
  EventList,
  EvidenceLabel,
  Fieldset,
  Form,
  FormActions,
  FormAlert,
  FormRow,
  Heading,
  Hero,
  IconButton,
  Kicker,
  KindBadge,
  LifecycleChip,
  Link,
  MagazineCover,
  MediaFrame,
  Meta,
  Pagination,
  PasswordField,
  Prose,
  Quote,
  RecordStatusChip,
  RunStatusBadge,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Spinner,
  StatusChip,
  Stepper,
  StoryCard,
  Switch,
  Tabs,
  TagSelect,
  Text,
  TextArea,
  TextField,
  Timeline,
  UiProvider,
  VisuallyHidden,
} from '@trustwork/ui';
