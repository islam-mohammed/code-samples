import { ChangeDetectorRef, Directive, Input, OnInit } from '@angular/core';
import { Store } from '@ngrx/store';
import { WindowService } from '@pnp/features/shared/services';
import { debounceTime, distinctUntilChanged, map, takeUntil } from 'rxjs/operators';
import { IValidateTargetUpdate } from '../../../services';
import { FormActions, FormState } from '../../../state';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';

const cmpName = 'FormTextBaseComponent'; // debugging
/**
 * Form text abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormTextBaseComponent extends FormElementBaseComponent implements OnInit {
  @Input()
  debounceTime = 1000;
  @Input()
  forceTypeahead: boolean;

  isPhone: boolean;

  protected constructor(
    store: Store<FormState.IFeatureState>,
    protected win: WindowService,
    protected cdRef: ChangeDetectorRef
  ) {
    super(store);
  }

  ngOnInit() {
    if (this.config) {
      this.isPhone = ['phone', 'phoneNumber'].includes(this.config.name);
      this._handleTypeAhead();
    }

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
          // when hiding, clear validations
          this.clearValidators(true);
        } else if (['requiredIfNotEmpty', 'requiredIfValue'].includes(update.type)) {
          // reveal field
          this.config.hidden = false;
          // add required validation
          this.setRequired();
        }
      }
    });
  }

  textChange(e) {
    let audioField = '';
    if (this.config.name.startsWith('toFirstName')) {
      audioField = this.config.name + 'Id';
    } else {
      audioField = this.config.name + 'Audio';
    }
    this.formService.setCustomPronunciations(null, audioField, true);
  }

  private _handleTypeAhead() {
    if (this.config.name.startsWith('toFirstName')) {
      this.group.valueChanges
        .pipe(
          map(formValue => formValue[this.config.name]),
          debounceTime(this.debounceTime),
          distinctUntilChanged(),
          takeUntil(this.destroy$)
        )
        .subscribe((name: string) => {
          if (name) {
            this.store.dispatch(
              new FormActions.GetFirstNamesAction({
                name,
                fieldName: this.config.name
              })
            );
          }
        });
    }
  }
}
