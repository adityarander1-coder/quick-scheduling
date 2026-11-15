// Healthcare shift-type presets (Deepika, 2026-11-14).
//
// ONE shared catalog for every company — no migration, no per-company
// table. A preset is pulled ONCE as a copy through the normal shift-type
// create path; after that it is an ordinary shift type whose name and
// times are editable like any other, with no link back to the preset.
// The list is open to anyone who can manage shift types.
//
// Times are 24-hour "HH:MM". start12/end12 are the standard 12-hour
// times (7-to-7 is the hospital default); start8/end8 are the 8-hour
// form. start8/end8 null = fixed time — the length choice does not
// apply to that preset (e.g. Physical Therapist 08:00–17:00).
// Anesthesiologist On-Call is 24 hours: 00:00–00:00, which the conflict
// checker reads as 24h (end <= start rolls +1440 minutes).
export interface HealthcareShiftPreset {
  group: string;
  name: string;
  shortName: string;
  start12: string;
  end12: string;
  start8: string | null;
  end8: string | null;
}

export const HEALTHCARE_SHIFT_PRESETS: HealthcareShiftPreset[] = [
  // Physicians
  { group: 'Physicians', name: 'Day Hospitalist', shortName: 'DH', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Physicians', name: 'Night Hospitalist (Nocturnist)', shortName: 'NH', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Physicians', name: 'Swing / Evening Hospitalist', shortName: 'EVE', start12: '15:00', end12: '23:00', start8: '15:00', end8: '23:00' },
  { group: 'Physicians', name: 'Day Intensivist (ICU)', shortName: 'DI', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Physicians', name: 'Night Intensivist', shortName: 'NI', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Physicians', name: 'ED Physician Day', shortName: 'ED', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Physicians', name: 'ED Physician Night', shortName: 'EDN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Physicians', name: 'OB Hospitalist (Laborist)', shortName: 'OB', start12: '19:00', end12: '08:00', start8: null, end8: null },
  { group: 'Physicians', name: 'Weekend Hospitalist', shortName: 'WE', start12: '07:00', end12: '16:00', start8: null, end8: null },
  { group: 'Physicians', name: 'On-Call Physician', shortName: 'OC', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Physicians', name: 'Anesthesiologist On-Call', shortName: 'ANE', start12: '00:00', end12: '00:00', start8: null, end8: null },
  // Nurse practitioners & physician assistants
  { group: 'Nurse practitioners & physician assistants', name: 'Day NP', shortName: 'DNP', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Nurse practitioners & physician assistants', name: 'Night NP', shortName: 'NNP', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Nurse practitioners & physician assistants', name: 'Swing NP', shortName: 'SNP', start12: '10:00', end12: '22:00', start8: '10:00', end8: '18:00' },
  { group: 'Nurse practitioners & physician assistants', name: 'Day PA', shortName: 'DPA', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Nurse practitioners & physician assistants', name: 'Night PA', shortName: 'NPA', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  // Nursing
  { group: 'Nursing', name: 'Day RN', shortName: 'DRN', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Nursing', name: 'Night RN', shortName: 'NRN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Nursing', name: 'Evening RN', shortName: 'ERN', start12: '15:00', end12: '23:00', start8: '15:00', end8: '23:00' },
  { group: 'Nursing', name: 'Twilight RN', shortName: 'TRN', start12: '16:00', end12: '22:00', start8: null, end8: null },
  { group: 'Nursing', name: 'Charge Nurse Day', shortName: 'CD', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Nursing', name: 'Charge Nurse Night', shortName: 'CN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Nursing', name: 'CNA / PCT Day', shortName: 'CNA', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Nursing', name: 'CNA / PCT Night', shortName: 'CNAN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  // Allied health & support
  { group: 'Allied health & support', name: 'Respiratory Therapist Day', shortName: 'RTD', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Allied health & support', name: 'Respiratory Therapist Night', shortName: 'RTN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Allied health & support', name: 'Pharmacist Day', shortName: 'PHD', start12: '08:00', end12: '20:00', start8: '08:00', end8: '16:00' },
  { group: 'Allied health & support', name: 'Pharmacist Night', shortName: 'PHN', start12: '20:00', end12: '08:00', start8: '22:00', end8: '06:00' },
  { group: 'Allied health & support', name: 'Lab Tech Day', shortName: 'LAB', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Allied health & support', name: 'Lab Tech Night', shortName: 'LABN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Allied health & support', name: 'Radiology Tech Day', shortName: 'RAD', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Allied health & support', name: 'Radiology Tech Night', shortName: 'RADN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Allied health & support', name: 'Physical Therapist', shortName: 'PT', start12: '08:00', end12: '17:00', start8: null, end8: null },
  { group: 'Allied health & support', name: 'Phlebotomist Day', shortName: 'PHL', start12: '07:00', end12: '19:00', start8: '07:00', end8: '15:00' },
  { group: 'Allied health & support', name: 'Phlebotomist Night', shortName: 'PHLN', start12: '19:00', end12: '07:00', start8: '23:00', end8: '07:00' },
  { group: 'Allied health & support', name: 'Case Manager', shortName: 'CM', start12: '08:00', end12: '17:00', start8: null, end8: null },
  { group: 'Allied health & support', name: 'Social Worker', shortName: 'SW', start12: '08:00', end12: '17:00', start8: null, end8: null },
];
