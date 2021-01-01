import { OnInit, Directive } from '@angular/core';
import { select, Store } from '@ngrx/store';
import { UserRecipient, ValidationRequiredIfValue } from '@pnp/api';
import { IQuestionChoiceOptions } from '@pnp/features/form';
import { WindowService } from '@pnp/features/shared/services';
import { Subject } from 'rxjs';
import { debounce, distinctUntilChanged, map, takeUntil } from 'rxjs/operators';
import { IValidateTargetUpdate } from '../../../services';
import { FormState } from '../../../state';
import { FormSelectBaseComponent } from '../form-select/form-select.base-component';

export interface IOptionConfig {
  boy?: string;
  girl?: string;
  nice?: string;
  almost?: string;
  almostAlt?: string;
  naughty?: string;
}

/**
 * Form choice abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormChoiceBaseComponent extends FormSelectBaseComponent implements OnInit {
  isImage = false;
  isImagePair = false;
  isImageMultiple = false;
  isCheckbox = false;
  checkboxValue = '0';
  freeVideoMessage = false;
  optionsUpdated$: Subject<any>;
  private _allOptions: Array<any>;
  private _validateTargetInit = false;

  protected constructor(protected store: Store<FormState.IFeatureState>, protected win: WindowService) {
    super(store);
  }

  ngOnInit(): void {
    super.ngOnInit();
    this.formService.validateTargetUpdate$.pipe(takeUntil(this.destroy$)).subscribe((update: IValidateTargetUpdate) => {
      if (
        update.name === this.config.name &&
        (update.hasOwnProperty('checked') || update.hasOwnProperty('value') || update.hasOwnProperty('targetValues'))
      ) {
        let hidden = true;
        if (update.targetValues?.length) {
          hidden = !update.targetValues.includes(update.value);
        } else if (update.hasOwnProperty('checked')) {
          hidden = !parseInt(update.checked as any);
        } else {
          hidden = update.value !== this.config.value;
        }
        if (hidden) {
          this.clearValidators(true);
        } else if (['requiredIfNotEmpty', 'requiredIfValue'].includes(update.type)) {
          this.config.hidden = false;
          this.setRequired();
          this.adjustGroupOptions();
        }
      }
    });
    if (this.config?.options && this.config.options.length) {
      // preprocess options
      // determine based on first option
      this.isImage = !!this.config.options[0].imageUrl;
      for (const option of this.config.options) {
        option.class = this.getOptionConfig(option.value, this.getClassNames());
      }
      if (this.config.validateTargets?.length) {
        // if this field has validation targets, it should trigger them when value changes
        this.group.valueChanges
          .pipe(
            map(formValue => formValue[this.config.name]),
            distinctUntilChanged(),
            // if already initialized, fire right away on changes
            // however if just initializing, provide enough delay until all form values are known
            debounce(value => Promise.resolve(this._validateTargetInit ? 0 : 600)),
            takeUntil(this.destroy$)
          )
          .subscribe((value: any) => {
            this._validateTargetInit = true;
            this._triggerTargetValidations(value);
          });
      }
      if (this.config.options.length === 1 && this.config.name !== 'city') {
        this.isCheckbox = true;
        this.checkboxValue = '0';
        if (this.config.name === 'doNotKnowBirthday') {
          this.freeVideoMessage = true;
        }
      } else {
        if (this.isImage) {
          if (this.config.options.length === 2) {
            this.isImagePair = true;
          } else {
            this.isImageMultiple = true;
          }
        } else {
          if (this.config.parentQuestion) {
            this.optionsUpdated$ = new Subject();
            // dependent option on another field
            this._allOptions = [...this.config.options];
            // only show options relevant based on parent selection
            const currentParentValue = this.group.get(this.config.parentQuestion).value;
            if (currentParentValue) {
              // go ahead and trigger updates
              this._updateOptions(currentParentValue);
            } else {
              // start with this field hidden
              this.config.hidden = true;
            }
            // allow future changes to modify as well
            this.group.valueChanges
              .pipe(
                map(formValue => formValue[this.config.parentQuestion]),
                distinctUntilChanged(),
                takeUntil(this.destroy$)
              )
              .subscribe((value: any) => {
                // if this is country/location, ensure country exists on controls
                // fixes a case where location would get reset when moving from one page to another
                // TODO: backend form data setup around dependent validations needs serious revamp
                if (this.group?.controls && !this.group.controls[this.config.parentQuestion]) {
                  // ignore if parent question doesn't even exist on controls
                  return;
                }
                this._updateOptions(value);
              });
          }
        }
      }
      // setup any automatic configurations
      this._setupAutoConfigs();
    }
  }

  getOptionConfig(label: string, optionConfig: IOptionConfig): string {
    if (label) {
      label = label.toLowerCase().trim();
      const labelSearchRef = this.getLabelSearchRef();
      // TODO: gender should really have string values like all other choice values
      if (label.indexOf(labelSearchRef.boy) > -1 || (this.config.name === 'gender' && label === '1')) {
        return optionConfig.boy;
      } else if (label.indexOf(labelSearchRef.girl) > -1 || (this.config.name === 'gender' && label === '2')) {
        return optionConfig.girl;
      } else if (label === labelSearchRef.nice) {
        return optionConfig.nice;
      } else if (label.indexOf(labelSearchRef.almostAlt) > -1 || label.indexOf(labelSearchRef.almost) > -1) {
        return optionConfig.almost;
      } else if (label.indexOf(labelSearchRef.naughty) > -1) {
        return optionConfig.naughty;
      }
      return null;
    }
    return null;
  }

  getLabelSearchRef(): IOptionConfig {
    return {
      boy: 'boy',
      girl: 'girl',
      nice: 'nice',
      almost: 'almost nice',
      almostAlt: 'naughty-watch',
      naughty: 'naughty'
    };
  }

  /**
   * Can be overriden by either platform to customize classes for options
   */
  getClassNames(): IOptionConfig {
    return {
      boy: 'gender-box-boy',
      girl: 'gender-box-girl',
      nice: 'behavior-box-nice',
      almost: 'behavior-box-almost',
      naughty: 'behavior-box-naughty'
    };
  }

  selectSingle(option: IQuestionChoiceOptions): void {
    if (this.group.disabled || this.config.disabled) {
      return;
    }
    // reset all others
    for (const opt of this.config.options) {
      opt.selected = false;
    }
    option.selected = true;
    this.updateValue(option.value);
  }

  checkboxChange(checked: boolean): void {
    const isChecked = checked ? '1' : '0';
    this.checkboxValue = isChecked;
    this.updateValue(isChecked);
  }

  private _triggerTargetValidations(value: any) {
    if (this.config.validateTargets?.length) {
      for (const t of this.config.validateTargets) {
        this.formService.validateTargetUpdate$.next({
          errorMessage: t.errorMessage,
          name: t.reference,
          checked: value,
          reference: t.reference,
          target: t.target,
          targetValues: (<ValidationRequiredIfValue>t).targetValues,
          type: t.type,
          value
        });
      }
    }
  }

  private _setupAutoConfigs(): void {
    switch (this.config.name) {
      case 'gender':
      case 'location':
      case 'country':
        this.store
          .pipe(select(FormState.selectCurrentRecipient), distinctUntilChanged(), takeUntil(this.destroy$))
          .subscribe((selectedRecipient: UserRecipient) => {
            if (selectedRecipient?.data) {
              const value = selectedRecipient.data[this.config.name];
              this.config.value = value; // for binding updates
              // update options
              this._updateSelectableOptions(value);
              this.updateValue(value);
            } else if (this.config.name === 'gender') {
              // ensure selections are reset when no recipient has been selected
              this._updateSelectableOptions();
            }
          });
        break;
    }
  }

  private _updateSelectableOptions(value?: any): void {
    if (this.config.options?.length < 5) {
      // only needed for smaller choice lists
      // in reality, only less than 4 would be fine
      // but just in case larger block type of image lists are created in the futre, using 5 works for now
      for (const option of this.config.options) {
        option.selected = !!(value && option.value === value);
      }
    }
  }

  private _updateOptions(value: any) {
    if (value) {
      // filter options based on
      const visibleOptions = this._allOptions.filter(o => o.parentValue === value);
      if (visibleOptions?.length) {
        this._helpCountryLocationTmpFix(false);
        this.config.options = visibleOptions;
        this.config.hidden = false;
        // find if current value is still available in next options
        const currentValue = this.group.get(this.config.name).value;
        const isValidOption = visibleOptions.find(o => o.value === currentValue);
        if (!isValidOption) {
          this.updateValue(null);
        }
        // let view templates know that updates to widgets may need to happen
        this.optionsUpdated$.next(visibleOptions);
      } else {
        this._helpCountryLocationTmpFix(true);
        this.clearValidators(true);
      }
    } else {
      this._helpCountryLocationTmpFix(true);
      this.clearValidators(true);
    }
  }

  private _helpCountryLocationTmpFix(hasNoLocations: boolean) {
    if (this.config.name === 'location') {
      // helps solve transient issue:
      // backend should fix with better and smarter rules however not possible at time this came up
      // implementing frontend helper now with this
      this.formService.countryHasNoLocations = hasNoLocations;
    }
  }
}
