import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Phone, MessageSquare, Mail, Video, Users, MoreHorizontal } from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface DartboardContact {
  contactId: string;
  name: string;
  score: number;
  status: 'thriving' | 'healthy' | 'slipping' | 'drifting';
  pointsEarned: number;
  position: {
    radius: number;
    angle: number;
  };
}

interface DartboardProps {
  contacts: DartboardContact[];
  circleName: string;
  index?: number;
  total?: number;
}

// ===========================================================================
// Constants
// ===========================================================================

const STATUS_COLORS = {
  thriving: '#22c55e',  // green-500
  healthy: '#3b82f6',   // blue-500
  slipping: '#eab308',  // yellow-500
  drifting: '#ef4444',  // red-500
};

const RING_COLORS = [
  'rgba(34, 197, 94, 0.1)',   // Center - green tint
  'rgba(59, 130, 246, 0.08)', // Inner ring - blue tint
  'rgba(234, 179, 8, 0.06)',  // Middle ring - yellow tint
  'rgba(239, 68, 68, 0.04)',  // Outer ring - red tint
];

// ===========================================================================
// Component
// ===========================================================================

export function Dartboard({ contacts, circleName, index = 1, total = 1 }: DartboardProps) {
  const [hoveredContact, setHoveredContact] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<DartboardContact | null>(null);

  // SVG dimensions
  const size = 320;
  const center = size / 2;
  const maxRadius = size / 2 - 20; // Leave padding for dots outside circle

  // Convert polar to cartesian
  const polarToCartesian = (radius: number, angleDeg: number) => {
    const angleRad = (angleDeg - 90) * (Math.PI / 180); // Start from top
    const r = Math.min(radius, 1.3) * maxRadius * 0.85; // Cap at 1.3, scale to fit
    return {
      x: center + r * Math.cos(angleRad),
      y: center + r * Math.sin(angleRad),
    };
  };

  // Split contacts into inside and outside the circle
  const insideContacts = contacts.filter(c => c.position.radius <= 1.0);
  const outsideContacts = contacts.filter(c => c.position.radius > 1.0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-gray-900">
          {circleName}
          {total > 1 && (
            <span className="text-sm font-normal text-gray-500 ml-2">
              ({index} of {total})
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {contacts.filter(c => c.status === 'thriving').length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            {contacts.filter(c => c.status === 'healthy').length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            {contacts.filter(c => c.status === 'slipping').length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            {contacts.filter(c => c.status === 'drifting').length}
          </span>
        </div>
      </div>

      {/* Dartboard SVG */}
      <div className="relative flex justify-center">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible"
        >
          {/* Concentric rings */}
          {[0.85, 0.6, 0.35, 0.15].map((radiusRatio, i) => (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={maxRadius * radiusRatio}
              fill={RING_COLORS[i]}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          ))}

          {/* Ring labels */}
          <text
            x={center}
            y={center - maxRadius * 0.85 - 8}
            textAnchor="middle"
            className="fill-gray-400 text-[10px]"
          >
            drifting
          </text>
          <text
            x={center}
            y={center - maxRadius * 0.6 - 5}
            textAnchor="middle"
            className="fill-gray-400 text-[10px]"
          >
            slipping
          </text>
          <text
            x={center}
            y={center - maxRadius * 0.35 - 5}
            textAnchor="middle"
            className="fill-gray-400 text-[10px]"
          >
            healthy
          </text>

          {/* Contact dots inside circle */}
          {insideContacts.map((contact) => {
            const pos = polarToCartesian(contact.position.radius, contact.position.angle);
            const isHovered = hoveredContact === contact.contactId;
            const isSelected = selectedContact?.contactId === contact.contactId;

            return (
              <g key={contact.contactId}>
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={isHovered || isSelected ? 10 : 8}
                  fill={STATUS_COLORS[contact.status]}
                  stroke={isSelected ? '#1f2937' : 'white'}
                  strokeWidth={isSelected ? 2 : 1.5}
                  className="cursor-pointer transition-all duration-150"
                  style={{
                    filter: isHovered ? 'brightness(1.1)' : undefined,
                  }}
                  onMouseEnter={() => setHoveredContact(contact.contactId)}
                  onMouseLeave={() => setHoveredContact(null)}
                  onClick={() => setSelectedContact(
                    selectedContact?.contactId === contact.contactId ? null : contact
                  )}
                />
                {/* Name label on hover */}
                {isHovered && !isSelected && (
                  <text
                    x={pos.x}
                    y={pos.y - 14}
                    textAnchor="middle"
                    className="fill-gray-700 text-xs font-medium pointer-events-none"
                  >
                    {contact.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Outside contacts (drifting away) */}
        {outsideContacts.length > 0 && (
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1">
            {outsideContacts.slice(0, 5).map((contact) => (
              <div
                key={contact.contactId}
                className="w-4 h-4 rounded-full bg-red-500 border border-white cursor-pointer hover:scale-125 transition-transform"
                title={contact.name}
                onClick={() => setSelectedContact(
                  selectedContact?.contactId === contact.contactId ? null : contact
                )}
              />
            ))}
            {outsideContacts.length > 5 && (
              <span className="text-xs text-gray-500 ml-1">
                +{outsideContacts.length - 5}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Selected contact detail */}
      {selectedContact && (
        <ContactPopover
          contact={selectedContact}
          onClose={() => setSelectedContact(null)}
        />
      )}

      {/* Empty state */}
      {contacts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-gray-500">
          <Users className="w-8 h-8 mb-2 text-gray-300" />
          <p className="text-sm">No contacts in this circle yet</p>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Contact Popover
// ===========================================================================

interface ContactPopoverProps {
  contact: DartboardContact;
  onClose: () => void;
}

function ContactPopover({ contact, onClose }: ContactPopoverProps) {
  const statusLabels = {
    thriving: "You're doing great!",
    healthy: 'On track',
    slipping: 'Needs attention soon',
    drifting: 'Reach out today',
  };

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-medium text-gray-900">{contact.name}</h4>
          <p className="text-sm text-gray-500">
            <span
              className="inline-block w-2 h-2 rounded-full mr-1"
              style={{ backgroundColor: STATUS_COLORS[contact.status] }}
            />
            {statusLabels[contact.status]}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 bg-gray-200 rounded-full h-2">
          <div
            className="h-2 rounded-full transition-all"
            style={{
              width: `${Math.min(100, contact.score * 100)}%`,
              backgroundColor: STATUS_COLORS[contact.status],
            }}
          />
        </div>
        <span className="text-sm font-medium text-gray-600">
          {contact.pointsEarned}/100
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Link
          to={`/contacts/${contact.contactId}`}
          className="flex-1 text-center py-2 px-3 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          View profile
        </Link>
        <button className="p-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
          <Phone className="w-4 h-4 text-gray-600" />
        </button>
        <button className="p-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
          <MessageSquare className="w-4 h-4 text-gray-600" />
        </button>
        <button className="p-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
          <MoreHorizontal className="w-4 h-4 text-gray-600" />
        </button>
      </div>
    </div>
  );
}
