import { OnInit, Directive } from '@angular/core';
import { Store } from '@ngrx/store';

import { takeUntil } from 'rxjs/operators';
import { IValidateTargetUpdate } from '../../../services';
import { FormState } from '../../../state';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';

/**
 * Form time abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormTimeBaseComponent extends FormElementBaseComponent implements OnInit {
  protected constructor(public store: Store<FormState.IFeatureState>) {
    super(store);
  }

  ngOnInit() {
    if (this.formService.validateTargetUpdate$) {
      this.formService.validateTargetUpdate$
        .pipe(takeUntil(this.destroy$))
        .subscribe((update: IValidateTargetUpdate) => {
          if (update.name === this.config.name) {
            switch (update.type) {
              case 'emptyIfNotEmpty':
                this.config.disabled = !!parseInt(update.checked as any);
                break;
              case 'requiredIfEmpty':
                // check target
                if (update.target) {
                  const control = this.group.get(update.target);
                  if (control) {
                    if (control.value) {
                      // target is NOT empty, therefore should not be required any longer
                      this.clearValidators();
                    } else {
                      this.setRequired();
                    }
                  }
                }
                break;
            }
          }
        });
    }
  }

  public getTimeValue(hour: number | string, minute: number | string, ampm: string = ''): string {
    switch (ampm) {
      case 'am':
        if (+hour == 12) hour = 0;
        break;
      case 'pm':
        hour = +hour < 12 ? +hour + 12 : hour;
        break;
      default:
        // do nothing
        break;
    }
    hour = +hour < 10 ? `0${+hour}` : hour;
    minute = +minute < 10 ? `0${+minute}` : minute;
    return `${hour}:${minute}`;
  }
}
