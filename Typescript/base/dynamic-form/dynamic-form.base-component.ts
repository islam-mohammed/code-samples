import { Directive, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges } from '@angular/core';
import { FormBuilder, FormControl, FormGroup } from '@angular/forms';
import { BaseComponent } from '@pnp/features/shared/ui';
import { Observable, of } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { FormService } from '../../../services/form.service';
import { IFieldConfig, IQuestionChoiceOptions } from '../../models/field.model';

@Directive()
export abstract class DynamicFormBaseComponent extends BaseComponent implements OnChanges, OnInit {
  @Input()
  containerClass: string;
  @Input()
  configLeft: Array<IFieldConfig> = [];
  @Input()
  configRight: Array<IFieldConfig> = [];
  @Input()
  disabled = false;
  @Output()
  submit: EventEmitter<any> = new EventEmitter<any>();

  form: FormGroup;

  phoneCountryId: IFieldConfig;
  phoneCountryCode: IFieldConfig;
  phoneNumber: IFieldConfig;

  constructor(protected fb: FormBuilder, protected formService: FormService) {
    super();
  }

  get controls(): Array<IFieldConfig> {
    return this.configLeft.concat(this.configRight).filter(({ type }) => type !== 'button');
  }

  get changes(): Observable<any> {
    return this.form ? this.form.valueChanges : of(null);
  }

  get valid(): boolean {
    return this.form ? this.form.valid : false;
  }

  get value(): boolean {
    return this.form ? this.form.value : null;
  }

  ngOnInit() {
    this.form = this.createGroup();
    if (this.disabled) {
      this.form.disable();
    } else {
      this.form.enable();
    }
    this._initPhoneFields();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (this.form) {
      const controls = Object.keys(this.form.controls);
      const configControls = this.controls.map(item => item.name);
      controls
        .filter(control => !configControls.includes(control))
        .forEach(control => this.form.removeControl(control));
      configControls
        .filter(control => !controls.includes(control))
        .forEach(name => {
          const config = this.configLeft.concat(this.configRight).find(control => control.name === name);
          this.form.addControl(name, this.createControl(config));
        });
      // If entire form page is disabled, then disabled all components inside
      if (this.disabled || changes.disabled?.currentValue) {
        this.form.disable();
      } else {
        this.form.enable();
      }
    }
  }

  createGroup() {
    const group = this.fb.group({});
    this.controls.forEach(control => {
      group.addControl(control.name, this.createControl(control));
    });
    return group;
  }

  createControl(config: IFieldConfig): FormControl {
    const { disabled, validations, value } = config;
    return this.fb.control(
      {
        disabled,
        value
      },
      validations
    );
  }

  handleSubmit(event: Event) {
    if (event?.preventDefault) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.submit.emit(this.value);
  }

  setDisabled(name: string, disable: boolean) {
    if (this.form.controls[name]) {
      const method = disable ? 'disable' : 'enable';
      this.form.controls[name][method]();
      return;
    }
    this.configLeft = this.configLeft.map(item => {
      if (item.name === name) {
        item.disabled = disable;
      }
      return item;
    });
    this.configRight = this.configRight.map(item => {
      if (item.name === name) {
        item.disabled = disable;
      }
      return item;
    });
  }

  setValue(name: string, value: any) {
    if (this.form.controls[name]) {
      this.form.controls[name].setValue(value, {
        emitEvent: true
      });
    }
  }

  private _initPhoneFields() {
    this.phoneCountryId = this.configRight.find(f => f.name === 'phoneCountryId');
    this.phoneCountryCode = this.configRight.find(f => f.name === 'phoneCountryCode');
    this.phoneNumber = this.configRight.find(f => f.name === 'phoneNumber');

    if (this.phoneCountryId) {
      this.formService.countryData$
        .pipe(
          filter(data => !!data),
          takeUntil(this.destroy$)
        )
        .subscribe(data => {
          this.phoneCountryId.options = data.options as IQuestionChoiceOptions[];
          this._buildForm();
        });
    }
  }

  private _buildForm() {
    this.form.controls.phoneCountryId.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(country => {
      this.selectCountry(country);
    });
  }

  selectCountry(country: string) {
    const selectedCountry = this.formService.getCountryForCode(country);
    // Set country code to the input
    const telCodes = selectedCountry ? selectedCountry?.callingCodesList : [];

    if (telCodes?.length) {
      this.phoneNumber.prefix = `+${telCodes[0]}`;
      this.phoneCountryCode.hidden = telCodes.length <= 1;
      this.phoneCountryCode.options = telCodes.map(_code => {
        return {
          value: _code,
          label: _code
        };
      });

      this.formService.reloadFieldOptions$.next({
        name: this.phoneCountryCode.name,
        options: this.phoneCountryCode.options
      });
      this.form.patchValue({
        phoneCountryCode: telCodes[0]
      });
    } else {
      this.phoneNumber.prefix = `+1`;
      this.phoneCountryCode.hidden = true;
      this.form.patchValue({
        phoneCountryCode: '1' // default to US/CA
      });
      this.phoneCountryCode.options = [];
    }
  }
}
