// @trustwork/ui public surface. Styles: import '@trustwork/ui/tokens.css', '@trustwork/ui/fonts.css' and './styles/base.css' once per app.
export { t, formatMessage, formatNumber, formatDate, message, messageOrUndefined, locale, localeTag, intlTag, registerUiLocale, uiLocales, uiDictionary, FALLBACK_LOCALE, type LocaleKey, type LocaleParams } from './i18n';
export { tokens, blue, color, scrim, space, section, font, weight, type, radius, shadow, zIndex, breakpoint, mediaQuery, focus, motion, size, type TypeStyle } from '../tokens/index';
export { cx } from './utils/cx';
export { useMediaQuery, useIsMobile, usePrefersReducedMotion } from './hooks/useMediaQuery';
export { useEnter, type EnterOptions } from './hooks/useEnter';
export { coverFor, coverSizes, configureMedia, getMediaBase, hashSeed, listPhotos, listArtworks, photo, artwork, type MediaRef, type PhotoRef, type ArtworkRef, type MediaKind, type CoverOptions } from './media/index';

export { Heading, Text, Kicker, Meta, type HeadingProps, type TextProps, type KickerProps, type MetaProps, type HeadingLevel, type HeadingStyle, type TextStyle, type TextTone } from './components/Typography/Typography';
export { MediaFrame, type MediaFrameProps, type MediaSource, type MediaRatio, type MediaScrim } from './components/MediaFrame/MediaFrame';
export { Hero, type HeroProps } from './components/Hero/Hero';
export { StoryCard, type StoryCardProps, type StoryCardSize } from './components/StoryCard/StoryCard';
export { SectionHeader, type SectionHeaderProps } from './components/SectionHeader/SectionHeader';
export { Band, type BandProps, type BandTone } from './components/Band/Band';
export { DecisionCard, type DecisionCardProps, type DecisionTone } from './components/DecisionCard/DecisionCard';
export { EntityCard, type EntityCardProps, type EntityKind, type EntityFact } from './components/EntityCard/EntityCard';
export { MagazineCover, type MagazineCoverProps } from './components/MagazineCover/MagazineCover';
export { Quote, type QuoteProps } from './components/Quote/Quote';
export { Prose, type ProseProps } from './components/Prose/Prose';
export { DateTile, EventList, type DateTileProps, type EventItem, type EventListProps } from './components/DateTile/DateTile';
export { DemoBanner, type DemoBannerProps, type DemoPersona } from './components/DemoBanner/DemoBanner';

export { Brand, type BrandProps, type BrandVariant, type BrandTone } from './components/Brand/Brand';
export { Icon, type IconProps, type IconSize } from './components/Icon/Icon';
export { Spinner, type SpinnerProps } from './components/Spinner/Spinner';
export { VisuallyHidden, visuallyHiddenClass } from './components/VisuallyHidden/VisuallyHidden';
export { Button, IconButton, IconLink, ButtonLink, type ButtonProps, type IconButtonProps, type IconLinkProps, type ButtonLinkProps, type ButtonVariant, type ButtonSize } from './components/Button/Button';
export { Link, type LinkProps, type LinkVariant } from './components/Link/Link';
export { TextField, TextArea, PasswordField, type TextFieldProps, type TextAreaProps, type PasswordFieldProps } from './components/TextField/TextField';
export { Select, ComboBox, type SelectProps, type ComboBoxProps, type SelectOption } from './components/Select/Select';
export { Checkbox, CheckboxGroup, Radio, RadioGroup, Switch, type CheckboxProps, type CheckboxGroupProps, type RadioProps, type RadioGroupProps, type SwitchProps } from './components/Choice/Choice';
export {
  Form,
  FormAlert,
  Fieldset,
  FormRow,
  FormActions,
  Divider,
  type FormProps,
  type FormAlertProps,
  type FormAlertTone,
  type FieldsetProps,
  type FormRowProps,
  type FormActionsProps,
  type DividerProps,
} from './components/Form/Form';
export { Dialog, ConfirmDialog, DialogTrigger, type DialogProps, type ConfirmDialogProps, type DialogSize } from './components/Dialog/Dialog';
export { Popover, PopoverTrigger, type PopoverProps } from './components/Popover/Popover';
export { Menu, MenuTrigger, type MenuProps, type MenuItemDef } from './components/Menu/Menu';
export { Tabs, type TabsProps, type TabDef } from './components/Tabs/Tabs';
export { Tooltip, TooltipTrigger, type TooltipProps } from './components/Tooltip/Tooltip';
export { UiProvider, type UiProviderProps } from './components/UiProvider/UiProvider';
export { ToastProvider, ToastRegion, useToast, type ToastInput, type ToastRecord, type ToastTone } from './components/Toast/Toast';
export {
  Badge,
  StatusChip,
  RecordStatusChip,
  EvidenceLabel,
  KindBadge,
  LifecycleChip,
  RunStatusBadge,
  type BadgeProps,
  type StatusChipProps,
  type StatusTone,
  type RecordStatus,
  type EvidenceState,
  type OfferKind,
  type LifecycleState,
  type RunState,
} from './components/Badge/Badge';
export { Avatar, AvatarButton, initialsOf, type AvatarProps, type AvatarButtonProps, type AvatarSize } from './components/Avatar/Avatar';
export { Skeleton, SkeletonGroup, type SkeletonProps, type SkeletonGroupProps } from './components/Skeleton/Skeleton';
export { EmptyState, type EmptyStateProps } from './components/EmptyState/EmptyState';
export { Card, CardLink, type CardProps, type CardLinkProps } from './components/Card/Card';
export { Breadcrumb, type BreadcrumbProps, type BreadcrumbItem } from './components/Breadcrumb/Breadcrumb';
export { Pagination, type PaginationProps } from './components/Pagination/Pagination';
export { DataTable, type DataTableProps, type DataTableColumn, type TableSelection } from './components/DataTable/DataTable';
export { ComparisonTable, type ComparisonTableProps, type ComparisonCell, type ComparisonLine, type ComparisonOffer, type ComparisonReason } from './components/ComparisonTable/ComparisonTable';
export { VersionPicker, VersionPill, type VersionPickerProps, type VersionItem } from './components/VersionPicker/VersionPicker';
export {
  CitationChip,
  AnswerStatusLine,
  RetrievalStatusBanner,
  CitationDetails,
  type CitationChipProps,
  type CitationChipState,
  type CitationUnavailableReason,
  type AnswerStatus,
  type AnswerStatusLineProps,
  type RetrievalStatus,
  type RetrievalStatusBannerProps,
  type CitationDetailsProps,
  type CitationLocator,
} from './components/Citation/Citation';
export { Timeline, EvidenceList, type TimelineProps, type TimelineEvent, type TimelineMark, type EvidenceListItem } from './components/Timeline/Timeline';
export { Stepper, type StepperProps, type StepperStep } from './components/Stepper/Stepper';
export { TagSelect, RemovableTag, type TagSelectProps, type TagOption, type RemovableTagProps } from './components/TagSelect/TagSelect';
export { SidebarNav, type SidebarNavProps, type SidebarNavItem } from './components/SidebarNav/SidebarNav';
export { AppHeader, type AppHeaderProps } from './components/AppHeader/AppHeader';
export { PublicHeader, type PublicHeaderProps, type PublicNavProps } from './components/PublicShell/PublicHeader';
export { PublicFooter, type PublicFooterProps, type FooterLink } from './components/PublicShell/PublicFooter';
export { AuthShell, type AuthShellProps } from './components/AuthShell/AuthShell';
export { AssistantLauncher, type AssistantLauncherProps } from './components/Assistant/AssistantLauncher';
export { AssistantOverlay, type AssistantOverlayProps, type AssistantMessage } from './components/Assistant/AssistantOverlay';

// Controlled console compositions (DS-003).
export * from './components/ApprovalCard/ApprovalCard';
export * from './components/AuditTrail/AuditTrail';
export * from './components/BulkActionBar/BulkActionBar';
export * from './components/CalendarAgenda/CalendarAgenda';
export * from './components/CommandPalette/CommandPalette';
export * from './components/DetailDrawer/DetailDrawer';
export * from './components/DiffViewer/DiffViewer';
export * from './components/EffectiveAccess/EffectiveAccess';
export * from './components/FacetPanel/FacetPanel';
export * from './components/FilterBar/FilterBar';
export * from './components/InboxList/InboxList';
export * from './components/InlineHelp/InlineHelp';
export * from './components/KeyboardShortcuts/KeyboardShortcuts';
export * from './components/LockedRule/KillSwitchControl';
export * from './components/LockedRule/LockedRule';
export * from './components/MetricChart/MetricChart';
export * from './components/MetricChart/values';
export * from './components/NetworkMap/NetworkMap';
export * from './components/PermissionMatrix/PermissionMatrix';
export * from './components/RunHistory/RunHistory';
export * from './components/RunHistory/StatusLabel';
export * from './components/SavedViews/SavedViews';
export * from './components/ScopePicker/ScopePicker';
export * from './components/StepUpPrompt/ReasonField';
export * from './components/StepUpPrompt/StepUpPrompt';
export * from './components/StepUpPrompt/TypedConfirmation';
