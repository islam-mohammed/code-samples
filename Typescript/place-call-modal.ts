import { WebHelperService } from 'src/app/xplat/core/services/web-helper.service';
import { PhoneCallService } from '@pnp/features/shared/services/phone-call.service';
import { AppPhoneNumber } from './../../../../../libs/features/shared/services/phone-call.service';
import { ApiCountriesService, Countries } from './../../../../../libs/features/shared/services/api-countries.service';
import { PersoItemData } from './../../../../../libs/features/user/state/user.state';
import { AppPersoItem, PersoItemService } from '@pnp/features/shared/services/perso-item.service';
import { TokenString } from './../../../xplat/core/services/token-string';
import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { select, Store } from '@ngrx/store';
import { BaseQuestionType } from '@pnp/api';
import {
  BaseComponent,
  FormService,
  IDateConfig,
  IFieldConfig,
  ModalActions,
  PersoItemActions,
  ProgressService,
  UserState,
  WindowService
} from '@pnp/features';
import { getUTC } from '@pnp/utils';
import { format as DateFnsFormat } from 'date-fns';
import { Subject } from 'rxjs';
import { distinctUntilChanged, take, takeUntil } from 'rxjs/operators';
import { OptionInterface } from '../../../xplat/features/forms/components';
import { IUser } from '@pnp/features/shared/services/auth.service';
import { PhoneCall } from '@pnp/sdk';
import { last } from 'lodash-es';

export enum PlaceModalType {
  PLACE = 'place',
  SCHEDULE = 'schedule',
  RESCHEDULE = 'reschedule',
  CONFIRMATION = 'confirmation',
  VU_CALL = 'vu-call'
}

@Component({
  selector: 'pnp-place-call-modal',
  templateUrl: 'place-call-modal.component.html'
})
export class PlaceCallModalComponent extends BaseComponent implements OnInit, OnDestroy {
  @Input()
  public type: PlaceModalType; // passed from outside
  placeModalType = PlaceModalType;
  user: IUser;
  item: AppPersoItem;
  countries$: Subject<OptionInterface[]> = new Subject();
  form: FormGroup;
  countryConfig: IFieldConfig = {
    name: 'country',
    type: BaseQuestionType.choice,
    placeholder: TokenString.MyCreations.SELECT_COUNTRY_LBL,
    options: [],
    validations: [Validators.required]
  };
  dateConfig: IFieldConfig = {
    name: 'date',
    type: BaseQuestionType.text,
    label: '',
    disabled: false,
    validations: [Validators.required]
  };
  timeConfig: IFieldConfig = {
    name: 'time',
    type: BaseQuestionType.text,
    label: '',
    disabled: false,
    value: '00:00',
    validations: [Validators.required]
  };
  phoneConfig: IFieldConfig = {
    name: 'phone',
    type: 'number',
    placeholder: TokenString.Item.NUMBER_TO_CALL_LBL,
    label: '',
    prefix: '',
    disabled: true,
    validations: [Validators.required, Validators.pattern('[0-9]+')]
  };
  phoneCodeConfig: IFieldConfig = {
    name: 'phoneCode',
    type: 'number',
    placeholder: TokenString.MyCreations.COUNTRY_CODE_LBL,
    label: '',
    disabled: true,
    options: [],
    validations: []
  };
  isCalling = false;
  phoneNotFound = false;
  invalidDate = false;
  persoItemData: PersoItemData;
  placeCallStarted: (phoneNumber: AppPhoneNumber) => void;
  scheduleLbl = TokenString.MyCreations.SCHEDULE_LBL;

  // Confirmation flag for placing call. Will be switched to true when user clicks on 'Yes, place call now' butoon
  private _isPlacingConfirmed = false;
  private _countries: Countries = [];
  private _country: FormControl = new FormControl('', [Validators.required]);
  private _phone: FormControl = new FormControl('', [Validators.required, Validators.pattern('[0-9]+')]);
  private _phoneCode: FormControl = new FormControl('');
  private _date: FormControl = new FormControl('', [Validators.required]);
  private _time: FormControl = new FormControl('', [Validators.required]);

  get okCallLabel() {
    return TokenString.Call.OK_CALL_LBL(this.item.title);
  }

  get scheduleWindowPersoLabel() {
    return TokenString.MyCreations.SCHEDUAL_WINDOE_PERSO_LBL(this.item.title);
  }

  constructor(
    public formService: FormService /* view bound */,
    private _store: Store<any>,
    private _formBuilder: FormBuilder,
    private _progressService: ProgressService,
    private _win: WindowService,
    private _persoItemService: PersoItemService,
    private _phoneCallService: PhoneCallService,
    private _countriesService: ApiCountriesService,
    private _web: WebHelperService
  ) {
    super();

    this._buildForm();
  }

  ngOnInit() {
    this._initUser();
    this._persoItemService
      .getPersoDate(this.item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe((recipient: PersoItemData) => {
        this.persoItemData = recipient;
        // Show loader only when we need to prefill data to the form
        this.type === PlaceModalType.RESCHEDULE ? this._initCountries(true) : this._initCountries();
        if (this.item && (this.item.audioCall || this.item.multiDevice)) {
          this.dateConfig.date = this._getDateConfig();
          this.countries$.pipe(takeUntil(this.destroy$)).subscribe(countries => {
            if (
              this.item.audioCall?.latestPhoneNumber ||
              this.item.multiDevice?.latestPhoneNumber ||
              recipient.phoneNumber
            ) {
              this.form.patchValue({
                phone:
                  this.item?.audioCall?.latestPhoneNumber?.basePhoneNumber ||
                  this.item.multiDevice?.latestPhoneNumber?.basePhoneNumber ||
                  recipient.phoneNumber
              });
            }
            if (this.item && last(this.item?.audioCall?.phoneCallsList)?.status === PhoneCall.Status.SCHEDULED) {
              if (
                this.type === PlaceModalType.RESCHEDULE ||
                this.type === PlaceModalType.PLACE ||
                this.type === PlaceModalType.VU_CALL
              ) {
                this._patchItemData();
              }
            }
          });
        }
      });
  }

  ngOnDestroy() {
    super.ngOnDestroy();
  }

  close(value?: any, showConfirm = true) {
    let confirmMessage = TokenString.General.UNSAVED_CHANGES_MODAL;
    if (this.form.dirty && showConfirm && !this.isCalling) {
      this._win.confirm(confirmMessage).then(_ => {
        this._store.dispatch(new ModalActions.CloseAction(value));
      });
    } else {
      this._store.dispatch(new ModalActions.CloseAction(value));
    }
  }

  selectCountry(country: OptionInterface) {
    if (!country || !country.value) {
      return;
    }
    const selectedCountry = this._countries.find(_country => _country.code === country.value);
    this.phoneConfig.disabled = false;

    // Set country code to the input
    const telCodes = selectedCountry?.callingCodesList;
    if (telCodes?.length > 0) {
      this.phoneConfig.prefix = `+${telCodes[0]}`;
      this.phoneCodeConfig.options = telCodes.map(_code => {
        return {
          value: _code,
          label: _code
        };
      });
      this.form.patchValue({
        phoneCode: telCodes[0]
      });
    } else {
      this.phoneConfig.prefix = `+`;
      this.form.patchValue({
        phoneCode: ''
      });
      this.phoneCodeConfig.options = [];
    }
  }

  changeCode(code: string) {
    this.phoneConfig.prefix = `+${code}`;
  }

  confirmPlacing() {
    this._isPlacingConfirmed = true;
    this.type = PlaceModalType.PLACE;
    this._deleteAndPlace();
  }

  modifyCall() {
    this.type = PlaceModalType.RESCHEDULE;
    this._patchItemData();
  }

  showPlacingConfirmation() {
    this.type = PlaceModalType.CONFIRMATION;
  }

  call(form: FormGroup) {
    if (form.invalid) {
      return;
    }

    this.phoneNotFound = false;
    this.invalidDate = false;

    const appPhoneNumber: AppPhoneNumber = {
      basePhoneNumber: form.controls.phone.value,
      countryCode: form.controls.country.value.value, // value is object of {label and value}
      countryCallingCode: form.controls.phoneCode.value
    };

    if (this.type === PlaceModalType.PLACE) {
      // Ask user for remove call schedule before placing
      if (last(this.item?.audioCall?.phoneCallsList)?.delayedAt && !this._isPlacingConfirmed) {
        this.showPlacingConfirmation();
      } else {
        this._createCall(appPhoneNumber);
      }
    } else if (this.type === PlaceModalType.SCHEDULE) {
      if (!this._isDateValid(this._getDelayedDate())) {
        this.invalidDate = true;
        return;
      }
      this._createCall(appPhoneNumber, this._getDelayedDate());
    } else if (this.type === PlaceModalType.RESCHEDULE) {
      const appPhoneCall = this.item.audioCall.phoneCallsList.find(
        c => !!c.delayedAt && c.status === PhoneCall.Status.SCHEDULED
      );
      if (!this._isDateValid(this._getDelayedDate())) {
        this.invalidDate = true;
        return;
      }
      this._rescheduleCall(appPhoneCall.id, appPhoneNumber, this._getDelayedDate());
    } else if (this.type === PlaceModalType.VU_CALL) {
      this.close('Play VU', false);
      this.placeCallStarted(appPhoneNumber);
    }
  }

  unscheduleCall() {
    this._progressService.toggleSpinner(true);
    this._unscheduleCall()
      .pipe(takeUntil(this.destroy$))
      .subscribe(
        _ => {
          this._progressService.toggleSpinner();
          this._store.dispatch(new PersoItemActions.FetchAllAction());
          this.close('Unschedule', false);
        },
        error => {
          this._progressService.toggleSpinner();
          console.log('Error call unscheduling : ' + error);
        }
      );
  }

  private _initUser() {
    this._store.pipe(select(UserState.selectCurrent), distinctUntilChanged()).subscribe(user => {
      this.user = user;
    });
  }

  private _createCall(phoneNumber: AppPhoneNumber, delayedAt?: any) {
    this._progressService.toggleSpinner(true);
    this._phoneCallService.createPhoneCall(this.item.id, phoneNumber, delayedAt).subscribe(
      _ => {
        this._progressService.toggleSpinner();
        this._store.dispatch(new PersoItemActions.FetchAllAction());
        if (this.type === PlaceModalType.SCHEDULE) {
          // Just close modal if it is delayed call
          this.close('Delayed', false);
        } else {
          this.isCalling = true;
        }
      },
      (error: any) => {
        this.phoneNotFound = true;
        this._progressService.toggleSpinner();
        console.log('Error call placement : ' + error);
      }
    );
  }

  private _rescheduleCall(phoneCallId: number, phoneNumber: AppPhoneNumber, delayedAt: any) {
    this._progressService.toggleSpinner(true);
    this._phoneCallService
      .updatePhoneCall(phoneCallId, phoneNumber, delayedAt)
      .pipe(takeUntil(this.destroy$))
      .subscribe(
        _ => {
          this._progressService.toggleSpinner();
          this._store.dispatch(new PersoItemActions.FetchAllAction());
          this.close('Reschedule', false);
        },
        (error: any) => {
          this.phoneNotFound = true;
          this._progressService.toggleSpinner();
          console.log('Error call rescheduling : ' + error);
        }
      );
  }

  private _deleteAndPlace() {
    this._progressService.toggleSpinner(true);
    this._unscheduleCall()
      .pipe(takeUntil(this.destroy$))
      .subscribe(
        _ => {
          this.call(this.form);
          this._store.dispatch(new PersoItemActions.FetchAllAction());
        },
        error => {
          this._progressService.toggleSpinner();
          console.log('Error call placing : ' + error);
        }
      );
  }

  private _unscheduleCall() {
    const callAttempt = this.item.audioCall.phoneCallsList.find(
      c => !!c.delayedAt && c.status === PhoneCall.Status.SCHEDULED
    );
    return this._phoneCallService.deletePhoneCall(callAttempt.id);
  }

  private _getDelayedDate(isVU: boolean = false) {
    if (!isVU) {
      const date = new Date(this.form.controls.date.value);
      const time = this.form.controls.time.value.split(':').map((n: string) => +n);
      date.setHours(time[0], time[1], 0, 0);
      const utc = getUTC(date);
      return DateFnsFormat(utc, `yyyy-MM-dd'T'HH:mm:ss+0000`);
    } else {
      const date = new Date();
      const initCallAt = new Date(date.getTime() + this.item.multiDevice?.config?.initiateCallAt?.seconds * 1000);
      return DateFnsFormat(initCallAt, `yyyy-MM-dd'T'HH:mm:ss+0000`);
    }
  }

  private _initCountries(runLoader = false) {
    if (runLoader) {
      this._progressService.toggleSpinner(true);
    }

    this._countriesService
      .getCountriesList()
      .pipe(take(1), takeUntil(this.destroy$))
      .subscribe(data => {
        this._countries = data;
        const oprions = data.map(item => {
          return {
            label: item.name,
            value: item.code
          };
        });
        this.countryConfig.options = oprions;
        if (runLoader) {
          this._progressService.toggleSpinner();
        }

        const countryCode =
          this.item?.audioCall?.latestPhoneNumber?.countryCode ||
          this.item?.multiDevice?.latestPhoneNumber?.countryCode ||
          this.persoItemData.phoneCountryId;
        if (countryCode) {
          const selectedCountry = this._countries.find(_country => _country.code === countryCode);

          const country: OptionInterface = {
            label: selectedCountry.name,
            value: selectedCountry.code
          };
          setTimeout(() => {
            this.form.patchValue({
              country
            });
          });
        }
        this.countries$.next(oprions);
      });
  }

  private _pastDateValidator(formGroup: FormGroup): void {
    const now = new Date();
    const dateControl = formGroup.get('date');
    const timeControl = formGroup.get('time');
    const controlsDate = new Date(`${dateControl.value} ${timeControl.value}`);
    if (controlsDate < now) {
      dateControl.setErrors({
        pastDate: true
      });
      timeControl.setErrors({
        pastDate: true
      });
    } else {
      // Remove errors from controls
      dateControl.setErrors(null);
      timeControl.setErrors(null);
      return null;
    }
  }

  private _patchItemData() {
    const attempt = this.item.audioCall.phoneCallsList.find(
      c => !!c.delayedAt && c.status === PhoneCall.Status.SCHEDULED
    );
    if (!attempt) {
      throw new Error('This delayed item doesn`t have delayed date');
    }
    const matchedDate = new Date(attempt?.delayedAt?.seconds * 1000);
    const date = matchedDate;
    const time = DateFnsFormat(matchedDate, 'HH:mm');
    const selectedCountry = this._countries.find(_country => _country.code === attempt.phoneNumber.countryCode);
    const country: OptionInterface = {
      label: selectedCountry.name,
      value: selectedCountry.code
    };
    const phone = attempt.phoneNumber.basePhoneNumber;

    // Wait for init picker components and then patch them
    setTimeout(() => {
      this.form.patchValue({
        country,
        phone,
        phoneCode: attempt.phoneNumber.countryCallingCode.replace(/\+/g, ''),
        date,
        time
      });
    });
  }

  private _getDateConfig(): IDateConfig {
    const today: Date = new Date();
    const expiredDate: Date = new Date(this.item.archivedAt.seconds * 1000);
    return {
      defaultDate: today,
      minDate: today,
      maxDate: expiredDate
    };
  }

  private _isDateValid(date: string) {
    if (!date) {
      return false;
    }
    // Check if date not in the past

    const d = this._web.getPlatformDate(date);
    if (new Date() > new Date(d)) {
      return false;
    }
    return true;
  }

  private _buildForm() {
    this.form = this._formBuilder.group(
      {
        country: this._country,
        phone: this._phone,
        phoneCode: this._phoneCode,
        date: this._date,
        time: this._time
      },
      {
        validator: (formGroup: FormGroup) => {
          return this._pastDateValidator(formGroup);
        }
      }
    );
    this.form.controls.country.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(country => this.selectCountry(country));
    this.form.controls.phoneCode.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(code => this.changeCode(code));
  }
}
